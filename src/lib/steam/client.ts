import { SteamApiError } from '../steam';
import type { DailyBudget } from './budget';

/**
 * One HTTP path for every Steam call: per-attempt timeout, an overall deadline, jittered retry on
 * 429/5xx/network errors that honors `Retry-After`, a concurrency semaphore and an optional daily
 * budget for calls that carry the API key. Errors never carry URLs, keys or payloads.
 */

export type SteamErrorKind = 'private' | 'not_found' | 'invalid' | 'rate_limited' | 'unavailable' | 'budget_exhausted';

export class SteamClientError extends SteamApiError {
  readonly kind: SteamErrorKind;
  /** Seconds Steam asked us to wait, when it sent a usable `Retry-After`. */
  readonly retryAfterSeconds?: number;
  constructor(kind: SteamErrorKind, status = 0, retryAfterSeconds?: number) {
    super(status);
    this.kind = kind;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 401 and 403 are "private" because Steam uses both for hidden friends lists and game details (a bad key also lands here). */
export function classifySteamStatus(status: number): SteamErrorKind {
  if (status === 401 || status === 403) return 'private';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status >= 500 || status === 0) return 'unavailable';
  return 'invalid';
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Parses `Retry-After` as delta seconds or an HTTP date. Returns milliseconds, or null when absent or unusable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function createSemaphore(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit must be a positive integer');
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < limit) active++;
      else await new Promise<void>(resolve => queue.push(resolve));
      try {
        return await task();
      } finally {
        // Hand the slot straight to the next waiter so a newcomer cannot jump the queue.
        const next = queue.shift();
        if (next) next();
        else active--;
      }
    },
    get active() { return active; },
    get waiting() { return queue.length; },
  };
}

export type SteamClientOptions = {
  fetch?: typeof fetch;
  /** Simultaneous requests per client (per server instance for the shared client). */
  concurrency?: number;
  /** Per-attempt timeout, including reading the body. */
  timeoutMs?: number;
  /** Wall-clock cap for one call including every retry and wait; keeps routes under the Hosting 60 s ceiling. */
  deadlineMs?: number;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A `Retry-After` longer than this fails fast as `rate_limited` instead of waiting. */
  maxRetryAfterMs?: number;
  /** Consulted once per attempt of a keyed call. Keyless calls never touch it. */
  budget?: DailyBudget | null;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type SteamRequestOptions = {
  /** Non-2xx statuses returned to the caller as `{ status, data }` instead of thrown. */
  accept?: readonly number[];
  timeoutMs?: number;
  retries?: number;
};

export type SteamResponse<T> = { status: number; data: T | null };

export const STEAM_CLIENT_DEFAULTS = {
  concurrency: 5, timeoutMs: 12_000, deadlineMs: 25_000, retries: 2,
  baseDelayMs: 400, maxDelayMs: 4_000, maxRetryAfterMs: 5_000,
} as const;

export function createSteamClient(options: SteamClientOptions = {}) {
  const config = { ...STEAM_CLIENT_DEFAULTS, ...options };
  // Resolve the global lazily so test stubs of `fetch` apply to the shared client.
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const budget = options.budget ?? null;
  const semaphore = createSemaphore(config.concurrency);
  const counters = { requests: 0, retries: 0, keyed: 0, keyless: 0 };

  async function attempt(url: URL, timeoutMs: number) {
    return semaphore.run(async () => {
      counters.requests++;
      const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      return { response, text };
    });
  }

  async function request<T>(url: URL, requestOptions: SteamRequestOptions = {}): Promise<SteamResponse<T>> {
    const keyed = url.searchParams.has('key');
    const accept = requestOptions.accept ?? [];
    const retries = requestOptions.retries ?? config.retries;
    const startedAt = now();
    for (let attemptIndex = 0; ; attemptIndex++) {
      const remaining = config.deadlineMs - (now() - startedAt);
      if (remaining <= 0) throw new SteamClientError('unavailable');
      if (keyed && budget && !(await budget.take())) throw new SteamClientError('budget_exhausted');
      if (keyed) counters.keyed++; else counters.keyless++;
      let failure: SteamClientError;
      let retryAfterMs: number | null = null;
      try {
        const { response, text } = await attempt(url, Math.min(requestOptions.timeoutMs ?? config.timeoutMs, remaining));
        const { status } = response;
        if (response.ok || accept.includes(status)) {
          let data: T | null = null;
          try { data = text ? JSON.parse(text) as T : null; } catch { data = null; }
          if (response.ok && data === null) throw new SteamClientError('unavailable', status);
          return { status, data };
        }
        retryAfterMs = status === 429 || status === 503 ? parseRetryAfter(response.headers.get('retry-after'), now()) : null;
        failure = new SteamClientError(classifySteamStatus(status), status,
          retryAfterMs === null ? undefined : Math.ceil(retryAfterMs / 1000));
        if (!RETRY_STATUSES.has(status)) throw failure;
      } catch (error) {
        if (error instanceof SteamClientError) {
          if (!RETRY_STATUSES.has(error.status) && error.status !== 0) throw error;
          failure = error;
        } else {
          // Network failure or timeout. The original error is dropped because its message or cause can hold the URL.
          failure = new SteamClientError('unavailable');
        }
      }
      if (attemptIndex >= retries) throw failure;
      if (retryAfterMs !== null && retryAfterMs > config.maxRetryAfterMs) throw failure;
      const backoff = random() * Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** attemptIndex);
      const wait = retryAfterMs !== null ? retryAfterMs + random() * config.baseDelayMs : backoff;
      if (now() - startedAt + wait >= config.deadlineMs) throw failure;
      counters.retries++;
      await sleep(wait);
    }
  }

  /** Like `request`, but only for 2xx answers; anything else throws a `SteamClientError`. */
  async function json<T>(url: URL, requestOptions: Omit<SteamRequestOptions, 'accept'> = {}): Promise<T> {
    return (await request<T>(url, requestOptions)).data as T;
  }

  return {
    request,
    json,
    stats: () => ({ ...counters, active: semaphore.active, waiting: semaphore.waiting }),
  };
}

export type SteamClient = ReturnType<typeof createSteamClient>;

let sharedClient: SteamClient | null = null;

/** The process-wide client used by the endpoint wrappers when no client is passed. */
export function getSteamClient(): SteamClient {
  return sharedClient ??= createSteamClient();
}

/** Replaces the shared client, for example to attach a Firestore-backed daily budget at startup. `null` resets it. */
export function setSteamClient(client: SteamClient | null): void {
  sharedClient = client;
}
