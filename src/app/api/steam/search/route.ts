import { NextResponse } from 'next/server';
import { clientIpFromForwardedFor } from '@/lib/client-ip';
import { isSteamId, logServerError, parseSteamSearch, steamApiUrl, steamJson } from '@/lib/steam';
import { SteamProfileResponse } from '@/types/api';

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 10_000;

const requests = new Map<string, { start: number; count: number }>();
const cache = new Map<string, { expires: number; status: number; body: object }>();

function prune<T>(map: Map<string, T>, expired: (value: T) => boolean) {
  for (const [key, value] of map) {
    if (map.size < MAX_ENTRIES && !expired(value)) break;
    map.delete(key);
  }
}

function rateLimited(req: Request, now: number): boolean {
  const ip = clientIpFromForwardedFor(req.headers);
  const entry = requests.get(ip);
  if (entry && now - entry.start < RATE_WINDOW_MS) return ++entry.count > RATE_LIMIT;
  requests.delete(ip);
  prune(requests, value => now - value.start >= RATE_WINDOW_MS);
  requests.set(ip, { start: now, count: 1 });
  return false;
}

async function lookup(input: { steamId: string } | { vanity: string }): Promise<{ status: number; body: object }> {
  let steamId: unknown;
  if ('steamId' in input) steamId = input.steamId;
  else {
    const resolved = await steamJson<{ response: { steamid?: string } }>(steamApiUrl('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: input.vanity }));
    steamId = resolved.response.steamid;
  }
  if (!isSteamId(steamId)) return { status: 404, body: { error: 'Steam profile not found' } };
  const data = await steamJson<SteamProfileResponse>(steamApiUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }));
  const player = data.response.players.find(player => player.steamid === steamId);
  if (!player) return { status: 404, body: { error: 'Steam profile not found' } };
  let steamLevel: number | undefined;
  let badgeCount: number | undefined;
  if (player.communityvisibilitystate === 3) {
    const [levelResult, badgesResult] = await Promise.allSettled([
      steamJson<{ response?: { player_level?: number } }>(steamApiUrl('/IPlayerService/GetSteamLevel/v1/', { steamid: steamId })),
      steamJson<{ response?: { badges?: unknown[] } }>(steamApiUrl('/IPlayerService/GetBadges/v1/', { steamid: steamId })),
    ]);
    const level = levelResult.status === 'fulfilled' ? levelResult.value.response?.player_level : undefined;
    if (typeof level === 'number' && Number.isInteger(level)) {
      steamLevel = level;
    }
    const badges = badgesResult.status === 'fulfilled' ? badgesResult.value.response?.badges : undefined;
    if (Array.isArray(badges)) {
      badgeCount = badges.length;
    }
  }
  return { status: 200, body: {
    steamId: player.steamid, personaName: player.personaname, profileUrl: player.profileurl,
    avatarFull: player.avatarfull, avatarMedium: player.avatarmedium,
    communityVisibilityState: player.communityvisibilitystate, profileState: player.profilestate,
    ...(steamLevel === undefined ? {} : { steamLevel }),
    ...(badgeCount === undefined ? {} : { badgeCount }),
  } };
}

export async function GET(req: Request) {
  try {
    const now = Date.now();
    if (rateLimited(req, now)) {
      return NextResponse.json({ error: 'Too many searches. Please wait a minute and try again.' }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    const query = new URL(req.url).searchParams.get('q');
    const input = query && query.length <= 256 ? parseSteamSearch(query) : null;
    if (!input) return NextResponse.json({ error: 'Invalid Steam ID or profile URL' }, { status: 400 });
    const key = 'steamId' in input ? `id:${input.steamId}` : `vanity:${input.vanity}`;
    let result = cache.get(key);
    if (!result || result.expires <= now) {
      result = { ...await lookup(input), expires: now + CACHE_TTL_MS };
      cache.delete(key);
      prune(cache, value => value.expires <= now);
      cache.set(key, result);
    }
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    logServerError('Error searching Steam profile', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
