import type { DocumentReference } from 'firebase-admin/firestore';

/**
 * Daily budget for key-metered Steam calls (the Steam Web API terms allow 100,000 per key per day).
 * Each instance reserves calls in blocks from a shared store, so a Firestore-backed store makes the
 * limit global across instances at one transaction per block instead of one write per call.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Headroom below the 100,000 key quota for manual checks and unmetered retries elsewhere. */
export const DEFAULT_DAILY_KEY_BUDGET = 90_000;
export const DEFAULT_BUDGET_BLOCK = 25;

export interface BudgetStore {
  /** Reserves up to `amount` calls for `day` without exceeding `limit`. Resolves to the number granted (0 when exhausted). */
  reserve(day: string, amount: number, limit: number): Promise<number>;
}

export type DailyBudget = {
  /** Spends one call. False means the day's budget is exhausted and the caller should serve cached data. */
  take(): Promise<boolean>;
  status(): { day: string; localTokens: number; exhausted: boolean };
};

/** Steam's quota window is not documented; UTC days are used. */
export function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function memoryBudgetStore(): BudgetStore & { used(day: string): number } {
  const used = new Map<string, number>();
  return {
    async reserve(day, amount, limit) {
      for (const key of used.keys()) if (key < day) used.delete(key);
      const current = used.get(day) ?? 0;
      const granted = Math.max(0, Math.min(amount, limit - current));
      used.set(day, current + granted);
      return granted;
    },
    used: day => used.get(day) ?? 0,
  };
}

/**
 * Stores `{ used, day, updatedAt, expiresAt }` in one document per day. `docFor` supplies the
 * reference so collection paths stay with the store layer. `expiresAt` allows a Firestore TTL policy.
 */
export function firestoreBudgetStore(docFor: (day: string) => DocumentReference): BudgetStore {
  return {
    reserve(day, amount, limit) {
      const ref = docFor(day);
      return ref.firestore.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        const current = Number(snapshot.get('used')) || 0;
        const granted = Math.max(0, Math.min(amount, limit - current));
        if (granted > 0) {
          transaction.set(ref, {
            used: current + granted, day, updatedAt: new Date(),
            expiresAt: new Date(Date.parse(`${day}T00:00:00Z`) + 2 * DAY_MS),
          }, { merge: true });
        }
        return granted;
      });
    },
  };
}

export type DailyBudgetOptions = {
  limit?: number;
  block?: number;
  store?: BudgetStore;
  now?: () => number;
};

export function createDailyBudget({
  limit = DEFAULT_DAILY_KEY_BUDGET, block = DEFAULT_BUDGET_BLOCK, store = memoryBudgetStore(), now = Date.now,
}: DailyBudgetOptions = {}): DailyBudget {
  let day = utcDay(now());
  let tokens = 0;
  let exhausted = false;
  let pending: Promise<void> | null = null;

  function roll() {
    const today = utcDay(now());
    if (today !== day) {
      day = today;
      tokens = 0;
      exhausted = false;
    }
  }

  function refill(forDay: string): Promise<void> {
    // One reservation in flight per instance; concurrent callers share it.
    pending ??= store.reserve(forDay, block, limit).then(granted => {
      if (forDay !== day) return;
      tokens += granted;
      if (granted === 0) exhausted = true;
    }, () => {
      // Fail open when the store is unreachable: a guard outage must not take Steam down with it.
      if (forDay === day) tokens += block;
    }).finally(() => { pending = null; });
    return pending;
  }

  return {
    async take() {
      for (;;) {
        roll();
        if (tokens > 0) {
          tokens--;
          return true;
        }
        if (exhausted) return false;
        await refill(day);
      }
    },
    status() {
      roll();
      return { day, localTokens: tokens, exhausted };
    },
  };
}
