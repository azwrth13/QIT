import { getSteamClient, type SteamClient } from './client';
import { steamKeylessUrl } from './urls';

/** Live player counts and the top-100 concurrent-players chart (keyless, limited per IP). */

/** Current players, or null when the app has no counter (Steam answers 404 with `result: 42`). Null means unknown, never 0. */
export async function getCurrentPlayers(appid: number, client: SteamClient = getSteamClient()): Promise<number | null> {
  if (!Number.isSafeInteger(appid) || appid <= 0) throw new Error('Invalid app ID');
  const { data } = await client.request<{ response?: { player_count?: number; result?: number } }>(
    steamKeylessUrl('/ISteamUserStats/GetNumberOfCurrentPlayers/v1/', { appid: String(appid) }), { accept: [404] });
  const count = data?.response?.result === 1 ? data.response.player_count : undefined;
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : null;
}

export type ConcurrencyRank = { rank: number; appid: number; concurrent_in_game: number; peak_in_game: number };

const isRank = <T extends { rank?: number; appid?: number }>(rank: T | null | undefined): rank is T & { rank: number; appid: number } =>
  typeof rank?.rank === 'number' && typeof rank.appid === 'number' && Number.isSafeInteger(rank.appid) && rank.appid > 0;

export async function getGamesByConcurrentPlayers(client: SteamClient = getSteamClient()): Promise<{ lastUpdate: number | null; ranks: ConcurrencyRank[] }> {
  const data = await client.json<{ response?: { last_update?: number; ranks?: Array<Partial<ConcurrencyRank>> } }>(
    steamKeylessUrl('/ISteamChartsService/GetGamesByConcurrentPlayers/v1/'));
  return {
    lastUpdate: typeof data?.response?.last_update === 'number' ? data.response.last_update : null,
    ranks: (data?.response?.ranks ?? []).filter(isRank).map(rank => ({
      rank: rank.rank, appid: rank.appid, concurrent_in_game: rank.concurrent_in_game ?? 0, peak_in_game: rank.peak_in_game ?? 0,
    })),
  };
}
