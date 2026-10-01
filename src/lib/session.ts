import { sealData, unsealData } from 'iron-session';
import { isSteamId } from './steam';

export const SESSION_COOKIE = '__session';
export const SESSION_TTL = 60 * 60 * 24 * 7;
export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_TTL,
};

function password(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  return secret;
}

export async function createSession(steamId: string): Promise<string> {
  if (!isSteamId(steamId)) throw new Error('Invalid Steam ID');
  return sealData({ steamId, expiresAt: Date.now() + SESSION_TTL * 1000 }, { password: password(), ttl: SESSION_TTL });
}

export async function verifySession(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const secret = password();
  try {
    const data = await unsealData<{ steamId?: unknown; expiresAt?: unknown }>(token, { password: secret, ttl: SESSION_TTL });
    return isSteamId(data.steamId) && typeof data.expiresAt === 'number' && data.expiresAt > Date.now() ? data.steamId : null;
  } catch { return null; }
}

export const PRE_AUTH_TTL = 60 * 10;

export async function createPreAuthSession(next: string): Promise<string> {
  return sealData({ next, expiresAt: Date.now() + PRE_AUTH_TTL * 1000 }, { password: password(), ttl: PRE_AUTH_TTL });
}

export async function verifyPreAuthSession(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const data = await unsealData<{ next?: unknown; expiresAt?: unknown }>(token, { password: password(), ttl: PRE_AUTH_TTL });
    return typeof data.next === 'string' && typeof data.expiresAt === 'number' && data.expiresAt > Date.now() ? data.next : null;
  } catch { return null; }
}

export function isValidNextPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path) return false;
  if (path.startsWith('//') || path.includes('\\') || path.includes('%5C') || path.includes('%5c')) return false;
  
  try {
    new URL(path);
    return false;
  } catch {
    // Expected for relative URLs
  }

  try {
    const parsed = new URL(path, 'http://localhost');
    return /^\/lobby\/[^/]+$/.test(parsed.pathname);
  } catch {
    return false;
  }
}
