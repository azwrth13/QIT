export const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
export const OPENID_NAMESPACE = 'http://specs.openid.net/auth/2.0';

type SteamId = string & { readonly __steamId: unique symbol };

export function isSteamId(value: unknown): value is SteamId {
  return typeof value === 'string' && value.length === 17 && /^\d{17}$/.test(value);
}

export function steamApiUrl(path: string, params: Record<string, string>): URL {
  if ('steamid' in params && !isSteamId(params.steamid)) throw new Error('Invalid Steam ID');
  if ('steamids' in params && (params.steamids.split(',').length > 100 ||
    !params.steamids.split(',').every(isSteamId))) throw new Error('Invalid Steam ID');
  const key = process.env.STEAM_API_KEY;
  if (!key) throw new Error('Steam API key not configured');
  const url = new URL(path, 'https://api.steampowered.com');
  url.search = new URLSearchParams({ ...params, key }).toString();
  return url;
}

export async function steamJson<T>(url: URL, acceptedStatusesOrTimeout: number[] | number = [], timeoutMs = 15000): Promise<T> {
  const acceptedStatuses = Array.isArray(acceptedStatusesOrTimeout) ? acceptedStatusesOrTimeout : [];
  const timeout = typeof acceptedStatusesOrTimeout === 'number' ? acceptedStatusesOrTimeout : timeoutMs;
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
  if (!response.ok && !acceptedStatuses.includes(response.status)) throw new SteamApiError(response.status);
  return response.json() as Promise<T>;
}

export class SteamApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('Steam request failed');
    this.status = status;
  }
}

// Never pass messages, stacks, URLs, payloads or arbitrary error fields to logs.
export function logServerError(context: string, error: unknown): void {
  const name = error instanceof Error && ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error.name)
    ? error.name : 'Error';
  console.error(context, { name });
}

export function validateOpenId(params: URLSearchParams, returnTo: string): string | null {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!key.startsWith('openid.')) continue;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  if (params.get('openid.return_to') !== returnTo ||
      params.get('openid.op_endpoint') !== OPENID_ENDPOINT ||
      params.get('openid.ns') !== OPENID_NAMESPACE ||
      params.get('openid.mode') !== 'id_res') return null;
  const claimedId = params.get('openid.claimed_id');
  const match = claimedId?.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  if (!match || claimedId !== `https://steamcommunity.com/openid/id/${match[1]}` || params.get('openid.identity') !== claimedId) return null;
  const signed = new Set(params.get('openid.signed')?.split(','));
  if (!['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'].every(key => signed.has(key))) return null;
  return match[1];
}

export function parseSteamSearch(input: string): { steamId: string } | { vanity: string } | null {
  const cleaned = input.trim();
  if (isSteamId(cleaned)) return { steamId: cleaned };
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(cleaned)) return { vanity: cleaned };
  try {
    const url = new URL(cleaned.includes('://') ? cleaned : `https://${cleaned}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    if (url.hostname === 'steamcommunity.com') {
      const profile = url.pathname.match(/^\/profiles\/(\d{17})\/?$/);
      if (profile) return { steamId: profile[1] };
      const vanity = url.pathname.match(/^\/id\/([a-zA-Z0-9_-]{1,64})\/?$/);
      if (vanity) return { vanity: vanity[1] };
    }
    if (url.hostname === 'steam.me') {
      const profile = url.pathname.match(/^\/(\d{17})\/?$/);
      if (profile) return { steamId: profile[1] };
    }
  } catch { /* Invalid URL is invalid input. */ }
  return null;
}

import type { Game } from './games';

export interface SteamProfile {
  steamId: string;
  personaName: string;
  profileUrl: string;
  avatarFull: string;
  avatarMedium: string;
  public: boolean;
}

export async function getSteamProfile(steamId: string): Promise<SteamProfile | null> {
  if (!isSteamId(steamId)) return null;
  const data = await steamJson<{ response: { players: Array<{
    steamid: string; personaname: string; profileurl: string; avatarfull: string;
    avatarmedium: string; communityvisibilitystate: number;
  }> } }>(steamApiUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }));
  const player = data.response?.players?.find(player => player.steamid === steamId);
  if (!player) return null;
  return {
    steamId: player.steamid, personaName: player.personaname,
    profileUrl: player.profileurl, avatarFull: player.avatarfull,
    avatarMedium: player.avatarmedium, public: player.communityvisibilitystate === 3,
  };
}

export async function getSteamGames(steamId: string): Promise<Game[] | null> {
  if (!isSteamId(steamId)) return null;
  const data = await steamJson<{ response: { game_count?: number; games?: Game[] } }>(steamApiUrl('/IPlayerService/GetOwnedGames/v1/', { steamid: steamId, include_appinfo: 'true' }));
  if (!data.response?.games) return data.response?.game_count === 0 ? [] : null;
  return data.response.games.map(game => ({
    appid: game.appid, name: game.name, img_icon_url: game.img_icon_url || '',
    playtime_forever: game.playtime_forever || 0,
  }));
}

export type AchievementProgress = { unlocked: number; total: number; percent: number };

export async function getAchievementProgress(steamId: string, appid: number): Promise<AchievementProgress | null> {
  if (!isSteamId(steamId)) return null;
  // Steam answers 400 for games without stats and 403 for private game details,
  // both with a playerstats body whose success is false.
  const data = await steamJson<{ playerstats?: {
    success?: boolean;
    achievements?: Array<{ achieved?: number }>;
  } } | null>(steamApiUrl('/ISteamUserStats/GetPlayerAchievements/v1/', { steamid: steamId, appid: String(appid) }), [400, 403]);
  const stats = data?.playerstats;
  if (stats?.success === false) return null;
  if (stats?.success !== true) throw new Error('Steam request failed');
  if (!Array.isArray(stats.achievements) || stats.achievements.length === 0) return null;
  const total = stats.achievements.length;
  const unlocked = stats.achievements.filter(achievement => achievement.achieved === 1).length;
  return { unlocked, total, percent: Math.floor((unlocked / total) * 100) };
}

export async function getPublicLibrary(steamId: string) {
  if (!isSteamId(steamId)) return { state: 'unknown' as const, profile: null, games: [] };
  const profile = await getSteamProfile(steamId);
  if (!profile) return { state: 'unknown' as const, profile: null, games: [] };
  if (!profile.public) return { state: 'private' as const, profile, games: [] };
  const games = await getSteamGames(steamId);
  if (games === null) return { state: 'private' as const, profile, games: [] };
  return { state: 'public' as const, profile, games };
}

const PUBLIC_RATE_LIMIT = 20;
const PUBLIC_RATE_WINDOW_MS = 60 * 1000;
const PUBLIC_CACHE_MS = 5 * 60 * 1000;
const PUBLIC_MAP_LIMIT = 1000;
const publicRequests = new Map<string, { count: number; resetAt: number }>();
const publicCache = new Map<string, { expiresAt: number; library: ReturnType<typeof getPublicLibrary> }>();

export function makeRoom<K, T>(map: Map<K, T>, expiry: (value: T) => number, now: number, limit = PUBLIC_MAP_LIMIT) {
  if (map.size < limit) return;
  for (const [key, value] of map) if (expiry(value) <= now) map.delete(key);
  for (const key of map.keys()) {
    if (map.size < limit) break;
    map.delete(key);
  }
}

const publicMessages = {
  public: null,
  private: 'This library is private or Steam is not sharing its games. The owner can set Game details to Public in Steam privacy settings.',
  unknown: 'Steam profile not found. Check the Steam ID and try again.',
};

export async function getPublicLibraryResponse(steamId: string, clientIp: string, now = Date.now()) {
  if (!/^\d{17}$/.test(steamId)) return { status: 400, body: { error: 'Steam ID must be exactly 17 digits.' } };
  const bucket = publicRequests.get(clientIp);
  if (!bucket || bucket.resetAt <= now) {
    publicRequests.delete(clientIp);
    makeRoom(publicRequests, entry => entry.resetAt, now);
    publicRequests.set(clientIp, { count: 1, resetAt: now + PUBLIC_RATE_WINDOW_MS });
  } else if (bucket.count >= PUBLIC_RATE_LIMIT) {
    return { status: 429, body: { error: 'Too many requests. Please wait a minute and try again.' }, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  } else bucket.count++;
  let cached = publicCache.get(steamId);
  if (!cached || cached.expiresAt <= now) {
    publicCache.delete(steamId);
    makeRoom(publicCache, entry => entry.expiresAt, now);
    const entry = { expiresAt: now + PUBLIC_CACHE_MS, library: getPublicLibrary(steamId) };
    entry.library.catch(() => { if (publicCache.get(steamId) === entry) publicCache.delete(steamId); });
    publicCache.set(steamId, entry);
    cached = entry;
  }
  const library = await cached.library;
  return { status: library.state === 'unknown' ? 404 : 200, body: { ...library, message: publicMessages[library.state] } };
}
