// Local-day arithmetic for "Not tonight" (captain decisions D3 and D8: the user's local calendar day, from the
// browser's IANA timezone). Pure; no Firestore.

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (positive east of Greenwich). */
function offsetAt(ms: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(ms).map(part => [part.type, part.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return local - Math.floor(ms / 1000) * 1000;
}

/** The local calendar date (`yyyy-mm-dd`) at `ms` in `tz`; an invalid or missing zone falls back to UTC. */
export function localDate(ms: number, tz?: string): string {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first instant of the next local day after `ms` in `tz` (UTC when the zone is missing or invalid). DST-safe:
 * when a change falls at midnight, the day still ends at the first instant whose local date is the next day.
 */
export function endOfLocalDay(ms: number, tz?: string): number {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const [year, month, day] = localDate(ms, zone).split('-').map(Number);
  const midnightAsUtc = Date.UTC(year, month - 1, day + 1);
  const next = localDate(midnightAsUtc, 'UTC');
  // The offsets a day either side of the boundary bracket any DST change at midnight; keep the earliest candidate
  // that is already on the next local date.
  const candidates = [midnightAsUtc - offsetAt(midnightAsUtc - DAY_MS, zone), midnightAsUtc - offsetAt(midnightAsUtc + DAY_MS, zone)]
    .filter(candidate => localDate(candidate, zone) === next)
    .sort((a, b) => a - b);
  return candidates[0] ?? midnightAsUtc - offsetAt(midnightAsUtc, zone);
}
