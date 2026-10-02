import type { Game } from '../games';
import { THRESHOLDS } from '../roulette/thresholds';
import { markPlayed, recentRolls, type RollView } from './rolls';

const knownMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Unknown, missing, or reduced playtime supplies no evidence of play. */
export function hasPlayedDelta(atRoll: number | null, current: number | undefined): boolean {
  return knownMinutes(atRoll) && knownMinutes(current) && current - atRoll >= THRESHOLDS.playedDeltaMinutes;
}

/** A known Steam last-played time before the roll means the growth predates it (a stale baseline). */
function playedSinceRoll(roll: Pick<RollView, 'at' | 'playtimeAtRoll'>, game: Game | undefined): boolean {
  if (!game || !hasPlayedDelta(roll.playtimeAtRoll, game.playtime_forever)) return false;
  const lastPlayed = game.rtime_last_played;
  return typeof lastPlayed !== 'number' || lastPlayed >= Math.floor(roll.at.getTime() / 1000);
}

/**
 * Compares the freshly synced library with recent rolls. One play session marks at most the newest qualifying
 * unplayed roll of a game, and never a roll older than one already played, so a re-sync cannot walk back through
 * older rolls. Writes only through the roll store's transaction, so a retry or concurrent manual mark never emits
 * another played event or counter increment. Returns the number of new marks. A caller handles errors so
 * detection cannot invalidate a library sync.
 */
export async function detectPlayedRolls(
  steamId: string,
  library: { games: readonly Game[]; playtimeHidden: boolean },
  now = Date.now(),
): Promise<number> {
  if (library.playtimeHidden || !library.games.length) return 0;
  const games = new Map(library.games.map(game => [game.appid, game]));
  const settled = new Set<number>();
  let marked = 0;
  for (const roll of await recentRolls(steamId, now)) {
    if (settled.has(roll.appid)) continue;
    if (roll.playedAt) {
      settled.add(roll.appid);
      continue;
    }
    if (!playedSinceRoll(roll, games.get(roll.appid))) continue;
    settled.add(roll.appid);
    const result = await markPlayed(steamId, roll.id, 'sync', now);
    if (result.outcome === 'updated') marked++;
  }
  return marked;
}
