import { isSteamId } from '../steam';
import { getSteamClient, SteamClientError, type SteamClient } from './client';
import { steamKeyedUrl } from './urls';

/** `ISteamUser` profile, friends and vanity endpoints (keyed). */

export const PLAYER_SUMMARIES_BATCH = 100;

export type PlayerSummary = {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar?: string;
  avatarmedium?: string;
  avatarfull?: string;
  /** 3 = public; anything else means Steam returns only the public subset of fields. */
  communityvisibilitystate: number;
  /** 0 offline, 1 online, 2 busy, 3 away, 4 snooze, 5 looking to trade, 6 looking to play. Absent for some non-public profiles. */
  personastate?: number;
  lastlogoff?: number;
  /** Name of the game being played, when visible. */
  gameextrainfo?: string;
  gameid?: string;
};

/** Returns summaries keyed by Steam ID. Unknown or invalid IDs are simply absent. */
export async function getPlayerSummaries(steamIds: readonly string[], client: SteamClient = getSteamClient()): Promise<Map<string, PlayerSummary>> {
  const ids = [...new Set(steamIds.filter(isSteamId))];
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += PLAYER_SUMMARIES_BATCH) batches.push(ids.slice(offset, offset + PLAYER_SUMMARIES_BATCH));
  const results = await Promise.all(batches.map(batch => client.json<{ response?: { players?: PlayerSummary[] } }>(
    steamKeyedUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: batch.join(',') }))));
  const summaries = new Map<string, PlayerSummary>();
  for (const result of results) {
    for (const player of result?.response?.players ?? []) if (isSteamId(player?.steamid)) summaries.set(player.steamid, player);
  }
  return summaries;
}

export type Friend = { steamid: string; friend_since: number };
export type FriendListResult = { state: 'public'; friends: Friend[] } | { state: 'private' };

export async function getFriendList(steamId: string, client: SteamClient = getSteamClient()): Promise<FriendListResult> {
  if (!isSteamId(steamId)) throw new Error('Invalid Steam ID');
  // Steam answers a JSON 401 (and sometimes 403) for a private friends list; a bad key's HTML 401 or 403 is not private.
  const { status, data } = await client.request<{ friendslist?: { friends?: Array<{ steamid?: string; friend_since?: number }> } }>(
    steamKeyedUrl('/ISteamUser/GetFriendList/v1/', { steamid: steamId, relationship: 'friend' }), { accept: [401, 403] });
  if ((status === 401 || status === 403) && data === null) throw new SteamClientError('unavailable', status);
  if (!data?.friendslist) return { state: 'private' };
  const seen = new Set<string>();
  const friends: Friend[] = [];
  for (const friend of data.friendslist.friends ?? []) {
    if (!isSteamId(friend.steamid) || seen.has(friend.steamid)) continue;
    seen.add(friend.steamid);
    friends.push({ steamid: friend.steamid, friend_since: typeof friend.friend_since === 'number' ? friend.friend_since : 0 });
  }
  return { state: 'public', friends };
}

/** Resolves a custom profile name to a Steam ID, or null when Steam has no match. */
export async function resolveVanityUrl(vanity: string, client: SteamClient = getSteamClient()): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(vanity)) return null;
  const data = await client.json<{ response?: { success?: number; steamid?: string } }>(
    steamKeyedUrl('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: vanity }));
  const steamId = data?.response?.success === 1 ? data.response.steamid : undefined;
  return isSteamId(steamId) ? steamId : null;
}
