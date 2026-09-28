import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { isSteamId, logServerError, makeRoom, SteamApiError, steamApiUrl, steamJson } from '@/lib/steam';
import type { SteamProfileResponse } from '@/types/api';

const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 1_000;
type Friend = { steamId: string; personaName: string; profileUrl: string; avatarFull: string; avatarMedium: string };
type Result = { friends: Friend[]; message?: string };
const cache = new Map<string, { expiresAt: number; result: Promise<Result> }>();

async function lookup(steamId: string): Promise<Result> {
  let list: { friendslist?: { friends?: { steamid: string }[] } };
  try {
    list = await steamJson(steamApiUrl('/ISteamUser/GetFriendList/v1/', { steamid: steamId, relationship: 'friend' }));
  } catch (error) {
    if (error instanceof SteamApiError && (error.status === 401 || error.status === 403)) {
      return { friends: [], message: 'Your Steam friends list is private. Make your friends list public in Steam to see suggestions.' };
    }
    throw error;
  }
  const ids = [...new Set((list.friendslist?.friends ?? []).map(friend => friend.steamid).filter(isSteamId))];
  const players = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await steamJson<SteamProfileResponse>(steamApiUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: batch.join(',') }));
    players.push(...data.response.players);
  }
  const byId = new Map(players.map(player => [player.steamid, player]));
  return { friends: ids.flatMap(id => {
    const player = byId.get(id);
    return player ? [{ steamId: id, personaName: player.personaname, profileUrl: player.profileurl,
      avatarFull: player.avatarfull, avatarMedium: player.avatarmedium ?? player.avatarfull }] : [];
  }) };
}

export async function GET() {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try {
    const now = Date.now();
    let entry = cache.get(steamId);
    if (!entry || entry.expiresAt <= now) {
      cache.delete(steamId);
      makeRoom(cache, value => value.expiresAt, now, MAX_ENTRIES);
      entry = { expiresAt: now + CACHE_TTL_MS, result: lookup(steamId) };
      const current = entry;
      entry.result.catch(() => { if (cache.get(steamId) === current) cache.delete(steamId); });
      cache.set(steamId, entry);
    }
    return NextResponse.json(await entry.result, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch (error) {
    logServerError('Steam friends lookup failed', error);
    return NextResponse.json({ error: 'Could not load Steam friends. Please try again.' }, { status: 502 });
  }
}
