import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { paths } from '../store/paths';
import type { StatsSummaryRecord } from '../store/types';
import type { EventInput } from './events';

// The only writer of `users/{id}/stats/summary`. Counters move only as a side effect of `recordEvent`, in the
// same transaction as the event, so they never drift from the event log. Increments are blind merge writes,
// so concurrent events never contend on a read of the summary.

/** For these event types, one `meta` field also gets a per-value counter, for example `roll:modeId:dust-collector`. */
export const COUNTER_DIMENSIONS: Readonly<Record<string, string>> = Object.freeze({
  roll: 'modeId',
  accept: 'modeId',
  played: 'source',
  exclude: 'scope',
});

const DIMENSION_VALUE = /^[a-z0-9_-]{1,40}$/;

/** Counter keys an event increments: always its type, plus `type:field:value` for a dimension. Pure. */
export function countersFor(event: Pick<EventInput, 'type' | 'meta'>): string[] {
  const keys = [event.type];
  const field = COUNTER_DIMENSIONS[event.type];
  const value = field ? event.meta?.[field] : undefined;
  if (typeof value === 'string' && DIMENSION_VALUE.test(value)) keys.push(`${event.type}:${field}:${value}`);
  return keys;
}

const summaryRef = (steamId: string) => db.doc(paths.statsSummary(steamId));

/** Stages the counter increments for `event` in `tx`. Called only by `events.ts`. */
export function applyEventToStats(tx: Transaction, steamId: string, event: Pick<EventInput, 'type' | 'meta'>, at: Timestamp): void {
  const counters = Object.fromEntries(countersFor(event).map(key => [key, FieldValue.increment(1)]));
  tx.set(summaryRef(steamId), { counters, updatedAt: at }, { merge: true });
}

export interface StatsSummary {
  counters: Record<string, number>;
  streak: StatsSummaryRecord['streak'] | null;
  updatedAt: Date | null;
}

/** One read. A user with no events yet gets empty counters. */
export async function readStats(steamId: string): Promise<StatsSummary> {
  const data = (await summaryRef(steamId).get()).data();
  const counters: Record<string, number> = {};
  if (data?.counters && typeof data.counters === 'object') {
    for (const [key, value] of Object.entries(data.counters as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) counters[key] = value;
    }
  }
  return {
    counters,
    streak: data?.streak && typeof data.streak === 'object' ? data.streak as StatsSummaryRecord['streak'] : null,
    updatedAt: data?.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : null,
  };
}
