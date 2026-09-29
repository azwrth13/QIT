import { isSteamId } from '../steam';
import { getSteamClient, SteamClientError, type SteamClient } from './client';
import { steamKeyedUrl } from './urls';

/** `IPlayerService/GetOwnedGames` and `GetRecentlyPlayedGames` (keyed; target's Game details must be public). */

export type OwnedGame = {
  appid: number;
  name: string;
  img_icon_url: string;
  playtime_forever: number;
  /** Steam omits the field when it is 0. */
  playtime_2weeks: number;
  /** Unix seconds; null when Steam omits it. 0 is kept as sent: "never" for unplayed games, "unknown" for old played ones. */
  rtime_last_played: number | null;
  has_community_visible_stats: boolean;
};

export type OwnedGamesResult =
  | { state: 'public'; gameCount: number; games: OwnedGame[] }
  | { state: 'private' };

type RawOwnedGame = Partial<Omit<OwnedGame, 'rtime_last_played'>> & { appid?: unknown; rtime_last_played?: number };

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

function toOwnedGame(game: RawOwnedGame): OwnedGame | null {
  if (typeof game.appid !== 'number' || !Number.isSafeInteger(game.appid) || game.appid <= 0) return null;
  return {
    appid: game.appid,
    name: typeof game.name === 'string' ? game.name : '',
    img_icon_url: typeof game.img_icon_url === 'string' ? game.img_icon_url : '',
    playtime_forever: count(game.playtime_forever),
    playtime_2weeks: count(game.playtime_2weeks),
    rtime_last_played: typeof game.rtime_last_played === 'number' ? game.rtime_last_played : null,
    has_community_visible_stats: game.has_community_visible_stats === true,
  };
}

/** Valve excludes free games by default, so `include_played_free_games` is always sent. */
export async function getOwnedGames(steamId: string, client: SteamClient = getSteamClient()): Promise<OwnedGamesResult> {
  if (!isSteamId(steamId)) throw new Error('Invalid Steam ID');
  const data = await client.json<{ response?: { game_count?: number; games?: RawOwnedGame[] } }>(
    steamKeyedUrl('/IPlayerService/GetOwnedGames/v1/', { steamid: steamId, include_appinfo: '1', include_played_free_games: '1' }));
  const response = data?.response;
  // A private profile answers 200 with an empty `response`; a public empty library has game_count 0.
  if (!response || (!Array.isArray(response.games) && response.game_count !== 0)) return { state: 'private' };
  const games = (response.games ?? []).map(toOwnedGame).filter((game): game is OwnedGame => game !== null);
  return { state: 'public', gameCount: typeof response.game_count === 'number' ? response.game_count : games.length, games };
}

export type RecentGame = { appid: number; name: string; img_icon_url: string; playtime_2weeks: number; playtime_forever: number };
export type RecentlyPlayedResult = { state: 'public'; totalCount: number; games: RecentGame[] } | { state: 'private' };

export async function getRecentlyPlayedGames(steamId: string, limit?: number, client: SteamClient = getSteamClient()): Promise<RecentlyPlayedResult> {
  if (!isSteamId(steamId)) throw new Error('Invalid Steam ID');
  const params: Record<string, string> = { steamid: steamId };
  if (limit !== undefined) params.count = String(Math.max(1, Math.floor(limit)));
  const { status, data } = await client.request<{ response?: { total_count?: number; games?: RawOwnedGame[] } }>(
    steamKeyedUrl('/IPlayerService/GetRecentlyPlayedGames/v1/', params), { accept: [403] });
  if (status === 403 && data === null) throw new SteamClientError('unavailable', status);
  const response = data?.response;
  if (!response || typeof response.total_count !== 'number') return { state: 'private' };
  const games = (response.games ?? []).map(toOwnedGame).filter((game): game is OwnedGame => game !== null)
    .map(({ appid, name, img_icon_url, playtime_2weeks, playtime_forever }) => ({ appid, name, img_icon_url, playtime_2weeks, playtime_forever }));
  return { state: 'public', totalCount: response.total_count, games };
}
