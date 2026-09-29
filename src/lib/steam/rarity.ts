import { getSteamClient, SteamClientError, type SteamClient } from './client';
import { steamKeylessUrl } from './urls';

/** Global achievement unlock percentages (keyless; app-level, shareable across users). */

export type AchievementRarity = { apiname: string; percent: number };

/** Returns null for apps without stats (Steam answers `403 {}`). Steam sends `percent` as a string such as "74.1". */
export async function getGlobalAchievementPercentages(appid: number, client: SteamClient = getSteamClient()): Promise<AchievementRarity[] | null> {
  if (!Number.isSafeInteger(appid) || appid <= 0) throw new Error('Invalid app ID');
  const { status, data } = await client.request<{ achievementpercentages?: { achievements?: Array<{ name?: string; percent?: string | number }> } }>(
    steamKeylessUrl('/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/', { gameid: String(appid) }), { accept: [403] });
  if (status === 403 && data === null) throw new SteamClientError('unavailable', status);
  if (!data?.achievementpercentages) return null;
  return (data.achievementpercentages.achievements ?? []).flatMap(achievement => {
    const percent = typeof achievement?.percent === 'number' ? achievement.percent : Number.parseFloat(String(achievement?.percent));
    return typeof achievement?.name === 'string' && Number.isFinite(percent) ? [{ apiname: achievement.name, percent }] : [];
  });
}
