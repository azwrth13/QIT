import type { LibrarySignals } from '../types';

const DAY_SECONDS = 24 * 60 * 60;
/** Steam's `playtime_2weeks` covers fourteen days. */
const TWO_WEEKS_DAYS = 14;

export type Recency = 'within' | 'outside' | 'unknown';

/**
 * Whether the game was played in the last `days` days, from what the library index knows.
 *
 * Steam reports `rtime_last_played` as 0 for very old sessions, and the library index stores that as
 * null. A null with playtime above zero is genuinely unknown, unless `playtime2Weeks` settles it.
 * A game with no playtime at all counts as not played within any window.
 */
export function playedWithin(library: LibrarySignals, days: number, now: number): Recency {
  const { lastPlayedAt, playtime2Weeks, playtimeForever } = library;
  if (playtime2Weeks !== null && playtime2Weeks > 0 && days >= TWO_WEEKS_DAYS) return 'within';
  if (lastPlayedAt !== null) return now - lastPlayedAt <= days * DAY_SECONDS ? 'within' : 'outside';
  if (playtimeForever <= 0) return 'outside';
  if (playtime2Weeks === 0 && days <= TWO_WEEKS_DAYS) return 'outside';
  return 'unknown';
}
