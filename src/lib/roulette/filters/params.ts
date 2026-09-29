import type { Candidate, FilterVerdict, StoreFlag } from '../types';

// Helpers shared by the filter files. Request params arrive as untrusted JSON, so every filter's
// `parse` goes through these and rejects anything it does not recognise.

export type NoParams = Record<string, never>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * Reads params as an object with only the `allowed` keys. Missing params (`undefined` or `null`)
 * read as `{}`; anything else that is not a plain object, or has an extra key, returns null.
 */
export function paramObject(raw: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) return null;
  return Object.keys(raw).every(key => allowed.includes(key)) ? raw : null;
}

export function parseNoParams(raw: unknown): NoParams | null {
  return paramObject(raw, []) as NoParams | null;
}

/** True for a whole number within `[min, max]`. */
export function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Longest day count a filter accepts; ten years is far past any useful window. */
export const MAX_DAYS = 3650;

/**
 * Verdict for a store flag: true passes, false fails, and a missing family or a null flag is unknown
 * (the app has no store data yet, or the store lists it without that category).
 */
export function storeFlagVerdict(candidate: Candidate, ...flags: StoreFlag[]): FilterVerdict {
  const store = candidate.signals.store;
  if (!store) return 'unknown';
  const values = flags.map(flag => store.flags[flag]);
  if (values.includes(true)) return 'pass';
  return values.includes(null) ? 'unknown' : 'fail';
}

export interface DaysParams {
  days?: number;
}

/** Params for the filters that take an optional window in days. */
export function parseDaysParams(raw: unknown): DaysParams | null {
  const object = paramObject(raw, ['days']);
  if (!object) return null;
  if (object.days === undefined) return {};
  return isIntInRange(object.days, 1, MAX_DAYS) ? { days: object.days } : null;
}
