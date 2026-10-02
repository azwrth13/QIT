import type { Game } from '../games';
import { THRESHOLDS } from '../roulette/thresholds';
import { markPlayed, recentUnplayedRolls } from './rolls';

const knownMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Unknown, missing, or reduced playtime supplies no evidence of play. */
export function hasPlayedDelta(atRoll: number | null, current: number | undefined): boolean {
  return knownMinutes(atRoll) && knownMinutes(current) && current - atRoll >= THRESHOLDS.playedDeltaMinutes;
}

/**
 * Compares the freshly synced library with recent unplayed rolls. Writes only through the roll store's
 * transaction, so a retry or concurrent manual mark never emits another played event or counter increment.
 * Returns the number of new marks. A caller handles errors so detection cannot invalidate a library sync.
 */
export async function detectPlayedRolls(
  steamId: string,
  library: { games: readonly Game[]; playtimeHidden: boolean },
  now = Date.now(),
  rolledBefore = now,
): Promise<number> {
  if (library.playtimeHidden || !library.games.length) return 0;
  const playtime = new Map(library.games.map(game => [game.appid, game.playtime_forever]));
  const rolls = await recentUnplayedRolls(steamId, now, rolledBefore);
  let marked = 0;
  for (const roll of rolls) {
    if (!hasPlayedDelta(roll.playtimeAtRoll, playtime.get(roll.appid))) continue;
    const result = await markPlayed(steamId, roll.id, 'sync', now);
    if (result.outcome === 'updated') marked++;
  }
  return marked;
}
