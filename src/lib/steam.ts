export const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
export const OPENID_NAMESPACE = 'http://specs.openid.net/auth/2.0';

type SteamId = string & { readonly __steamId: unique symbol };

export function isSteamId(value: unknown): value is SteamId {
  return typeof value === 'string' && value.length === 17 && /^\d{17}$/.test(value);
}

export function steamApiUrl(path: string, params: Record<string, string>): URL {
  for (const name of ['steamid', 'steamids']) {
    if (name in params && !isSteamId(params[name])) throw new Error('Invalid Steam ID');
  }
  const key = process.env.STEAM_API_KEY;
  if (!key) throw new Error('Steam API key not configured');
  const url = new URL(path, 'https://api.steampowered.com');
  url.search = new URLSearchParams({ ...params, key }).toString();
  return url;
}

export async function steamJson<T>(url: URL): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Steam request failed');
  return response.json() as Promise<T>;
}

// Never pass messages, stacks, URLs, payloads or arbitrary error fields to logs.
export function logServerError(context: string, error: unknown): void {
  const name = error instanceof Error && ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error.name)
    ? error.name : 'Error';
  console.error(context, { name });
}

export function baseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_BASE_URL;
  if (configured) return new URL(configured).origin;
  if (process.env.NODE_ENV === 'production') throw new Error('NEXT_PUBLIC_BASE_URL is required');
  return 'http://localhost:3000';
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
