import { isSteamId } from '../steam';
import { getSteamClient, SteamClientError, classifySteamStatus, type SteamClient } from './client';
import { steamKeyedUrl } from './urls';

/** `ISteamUserStats` per-user achievements and the per-app schema (both keyed, one call per game). */

export type PlayerAchievement = {
  apiname: string;
  achieved: boolean;
  /** Unix seconds; null when locked. */
  unlocktime: number | null;
  /** Present only when a language (`l`) is sent. Hidden achievements may have a blank description. */
  name?: string;
  description?: string;
};

export type PlayerAchievementsResult =
  | { state: 'ok'; achievements: PlayerAchievement[] }
  /** HTTP 400, or an app whose stats list no achievements. */
  | { state: 'no_stats' }
  /** HTTP 403: the player's Game details are private. */
  | { state: 'private' };

type RawPlayerAchievement = { apiname?: string; achieved?: number; unlocktime?: number; name?: string; description?: string };

export async function getPlayerAchievements(
  steamId: string, appid: number, language: string | null = 'english', client: SteamClient = getSteamClient(),
): Promise<PlayerAchievementsResult> {
  if (!isSteamId(steamId)) throw new Error('Invalid Steam ID');
  if (!Number.isSafeInteger(appid) || appid <= 0) throw new Error('Invalid app ID');
  const params: Record<string, string> = { steamid: steamId, appid: String(appid) };
  if (language) params.l = language;
  const { status, data } = await client.request<{ playerstats?: { success?: boolean; achievements?: RawPlayerAchievement[] } }>(
    steamKeyedUrl('/ISteamUserStats/GetPlayerAchievements/v1/', params), { accept: [400, 403] });
  const stats = data?.playerstats;
  if (status !== 200) {
    // Only Steam's own `success: false` body is trusted; an HTML 403 can be a key or edge block.
    if (stats?.success === false) return status === 400 ? { state: 'no_stats' } : { state: 'private' };
    throw new SteamClientError(classifySteamStatus(status), status);
  }
  if (stats?.success !== true) throw new SteamClientError('unavailable', status);
  const achievements = (stats.achievements ?? []).flatMap(achievement => {
    if (typeof achievement?.apiname !== 'string') return [];
    const entry: PlayerAchievement = {
      apiname: achievement.apiname,
      achieved: achievement.achieved === 1,
      unlocktime: typeof achievement.unlocktime === 'number' && achievement.unlocktime > 0 ? achievement.unlocktime : null,
    };
    if (typeof achievement.name === 'string') entry.name = achievement.name;
    if (typeof achievement.description === 'string') entry.description = achievement.description;
    return [entry];
  });
  return achievements.length ? { state: 'ok', achievements } : { state: 'no_stats' };
}

export type SchemaAchievement = {
  name: string;
  displayName: string;
  /** Missing for many hidden achievements. */
  description?: string;
  hidden: boolean;
  icon?: string;
  icongray?: string;
};

/** Achievement definitions for an app, or an empty list when the app has none. */
export async function getSchemaForGame(appid: number, language: string | null = 'english', client: SteamClient = getSteamClient()): Promise<SchemaAchievement[]> {
  if (!Number.isSafeInteger(appid) || appid <= 0) throw new Error('Invalid app ID');
  const params: Record<string, string> = { appid: String(appid) };
  if (language) params.l = language;
  const data = await client.json<{ game?: { availableGameStats?: { achievements?: Array<Partial<SchemaAchievement> & { hidden?: number }> } } }>(
    steamKeyedUrl('/ISteamUserStats/GetSchemaForGame/v2/', params));
  return (data?.game?.availableGameStats?.achievements ?? []).flatMap(achievement => {
    if (typeof achievement?.name !== 'string') return [];
    const entry: SchemaAchievement = {
      name: achievement.name,
      displayName: typeof achievement.displayName === 'string' ? achievement.displayName : achievement.name,
      hidden: achievement.hidden === 1,
    };
    if (typeof achievement.description === 'string') entry.description = achievement.description;
    if (typeof achievement.icon === 'string') entry.icon = achievement.icon;
    if (typeof achievement.icongray === 'string') entry.icongray = achievement.icongray;
    return [entry];
  });
}
