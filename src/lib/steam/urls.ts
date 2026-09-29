import { isSteamId, steamApiUrl } from '../steam';

/**
 * URL builders. Keyed calls reuse `steamApiUrl` (which validates Steam IDs and appends the key);
 * keyless builders never read or send the key, so keyless endpoints cannot leak or spend it.
 */

const API_ORIGIN = 'https://api.steampowered.com';
const STORE_ORIGIN = 'https://store.steampowered.com';
const CDN_ORIGIN = 'https://cdn.cloudflare.steamstatic.com';
const API_PATH = /^\/[A-Za-z]+\/[A-Za-z]+\/v\d+\/$/;

function assertApiPath(path: string) {
  if (!API_PATH.test(path)) throw new Error('Invalid Steam API path');
}

export function steamKeyedUrl(path: string, params: Record<string, string>): URL {
  assertApiPath(path);
  return steamApiUrl(path, params);
}

export function steamKeylessUrl(path: string, params: Record<string, string> = {}): URL {
  assertApiPath(path);
  if (Object.keys(params).some(name => name.toLowerCase() === 'key')) throw new Error('Keyless Steam URL must not carry a key');
  if ('steamid' in params && !isSteamId(params.steamid)) throw new Error('Invalid Steam ID');
  const url = new URL(path, API_ORIGIN);
  url.search = new URLSearchParams(params).toString();
  return url;
}

export function steamStoreUrl(path: '/api/appdetails', params: Record<string, string>): URL {
  if (Object.keys(params).some(name => name.toLowerCase() === 'key')) throw new Error('Store URL must not carry a key');
  const url = new URL(path, STORE_ORIGIN);
  url.search = new URLSearchParams(params).toString();
  return url;
}

function assertAppId(appid: number) {
  if (!Number.isSafeInteger(appid) || appid <= 0) throw new Error('Invalid app ID');
}

/** 460x215 store header. Verified for app 620; some apps lack it, so callers fall back to the icon. */
export function steamHeaderImageUrl(appid: number): string {
  assertAppId(appid);
  return `${CDN_ORIGIN}/steam/apps/${appid}/header.jpg`;
}

/** 600x900 library capsule. Not every app has one. */
export function steamLibraryCapsuleUrl(appid: number): string {
  assertAppId(appid);
  return `${CDN_ORIGIN}/steam/apps/${appid}/library_600x900.jpg`;
}

/** Community icon from `GetOwnedGames` `img_icon_url` (or `GetItems` `assets.community_icon`). */
export function steamIconUrl(appid: number, iconHash: string): string | null {
  assertAppId(appid);
  if (!/^[0-9a-f]{40}$/.test(iconHash)) return null;
  return `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${iconHash}.jpg`;
}
