import { test, expect, vi, beforeEach, afterEach, describe } from 'vitest';
import { isValidNextPath, SESSION_COOKIE, createPreAuthSession, createSession, verifySession, verifyPreAuthSession, PRE_AUTH_TTL } from '../src/lib/session';

const { cookieValues, ensureUser } = vi.hoisted(() => ({
  cookieValues: new Map<string, string>(),
  ensureUser: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined,
  })
}));

vi.mock('../src/lib/library-data', () => ({ ensureUser }));

import { GET as loginGET } from '../src/app/api/auth/steam-login/route';
import { GET as callbackGET } from '../src/app/api/auth/steam-callback/route';
import { OPENID_ENDPOINT, OPENID_NAMESPACE } from '../src/lib/steam';

const steamId = '76561198000000000';

beforeEach(() => {
  cookieValues.clear();
  ensureUser.mockReset();
  vi.stubEnv('SESSION_SECRET', 'test-only-secret-with-at-least-32-characters');
  vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.example');
  vi.stubEnv('STEAM_API_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Next path validation', () => {
  test('validates next paths correctly', () => {
    expect(isValidNextPath('/lobby/123')).toBe(true);
    expect(isValidNextPath('/lobby/foo-bar')).toBe(true);
    expect(isValidNextPath(null)).toBe(false);
    expect(isValidNextPath(undefined)).toBe(false);
    expect(isValidNextPath('')).toBe(false);
    expect(isValidNextPath('http://example.com/library')).toBe(false);
    expect(isValidNextPath('https://localhost:3000/lobby/123')).toBe(false);
    expect(isValidNextPath('//example.com/lobby/123')).toBe(false);
    expect(isValidNextPath('\\\\example.com/lobby/123')).toBe(false);
    expect(isValidNextPath('/%5Cexample.com')).toBe(false);
    expect(isValidNextPath('/\\example.com')).toBe(false);
    expect(isValidNextPath('/etc/passwd')).toBe(false);
    expect(isValidNextPath('/lobby/../etc/passwd')).toBe(false);
    expect(isValidNextPath('/other-path')).toBe(false);
    expect(isValidNextPath('/library')).toBe(false);
    expect(isValidNextPath('/library?autosync=1')).toBe(false);
    expect(isValidNextPath('/library/123')).toBe(false);
    expect(isValidNextPath('/lobby/')).toBe(false);
    expect(isValidNextPath('/lobby/123/extra')).toBe(false);
    expect(isValidNextPath('@evil.com/../lobby/1')).toBe(false);
    expect(isValidNextPath('.evil.com/../lobby/1')).toBe(false);
    expect(isValidNextPath('lobby/1')).toBe(false);
    expect(isValidNextPath('/lobby/1?x=@evil.com')).toBe(false);
  });
});

describe('Steam login and callback next path flow', () => {
  test('exact return_to', async () => {
    const res = await loginGET(new Request('https://qit.example/api/auth/steam-login'));
    const url = new URL(res.headers.get('location')!);
    expect(url.searchParams.get('openid.return_to')).toBe('https://qit.example/api/auth/steam-callback');
  });

  test('cookie unseals to the lobby with flags', async () => {
    const cookie = (await loginGET(new Request('https://qit.example/api/auth/steam-login?next=/lobby/abc'))).cookies.get(SESSION_COOKIE);
    expect(await verifyPreAuthSession(cookie?.value)).toBe('/lobby/abc');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: PRE_AUTH_TTL });
  });

  test.each([undefined, '/lobby/abc'])('a signed-in user keeps their session (next=%j)', async (next) => {
    cookieValues.set(SESSION_COOKIE, await createSession(steamId));
    const res = await loginGET(new Request(`https://qit.example/api/auth/steam-login${next ? `?next=${next}` : ''}`));
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(res.headers.get('location')).toBe(`https://qit.example${next ?? '/library'}`);
  });

  test('a pre-auth payload never authenticates and a session never yields a next', async () => {
    expect(await verifySession(await createPreAuthSession('/lobby/abc'))).toBeNull();
    expect(await verifyPreAuthSession(await createSession(steamId))).toBeNull();
  });

  test('an expired pre-auth payload is ignored', async () => {
    const token = await createPreAuthSession('/lobby/abc');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + (PRE_AUTH_TTL + 120) * 1000);
    expect(await verifyPreAuthSession(token)).toBeNull();
  });

  test('rejects oversized lobby ids', async () => {
    const cookie = (await loginGET(new Request(`https://qit.example/api/auth/steam-login?next=/lobby/${'a'.repeat(65)}`))).cookies.get(SESSION_COOKIE);
    expect(cookie?.maxAge).toBe(0);
  });

  test('steam-callback retrieves valid next path and redirects', async () => {
    cookieValues.set(SESSION_COOKIE, await createPreAuthSession('/lobby/123'));
    
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'))
      .mockResolvedValueOnce(Response.json({ response: { players: [{ steamid: steamId, personaname: 'test', profileurl: `https://steamcommunity.com/profiles/${steamId}`, avatarfull: '', avatarmedium: '', communityvisibilitystate: 3 }] } }));
    ensureUser.mockResolvedValue(undefined);

    const params = new URLSearchParams({
      'openid.ns': OPENID_NAMESPACE, 'openid.mode': 'id_res',
      'openid.op_endpoint': OPENID_ENDPOINT, 'openid.return_to': 'https://qit.example/api/auth/steam-callback',
      'openid.claimed_id': `https://steamcommunity.com/openid/id/${steamId}`,
      'openid.identity': `https://steamcommunity.com/openid/id/${steamId}`,
      'openid.signed': 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
      'openid.response_nonce': 'nonce', 'openid.assoc_handle': 'handle', 'openid.sig': 'signature',
    });
    const req = new Request(`https://qit.example/api/auth/steam-callback?${params}`);
    
    const res = await callbackGET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://qit.example/lobby/123');

    const newSessionCookie = res.cookies.get(SESSION_COOKIE);
    expect(await verifySession(newSessionCookie?.value)).toBe(steamId);
  });

  test.each([undefined, '@evil.com/../lobby/1'])('steam-callback falls back to library?autosync=1 if next path is %j', async (next) => {
    cookieValues.clear();
    if (next !== undefined) cookieValues.set(SESSION_COOKIE, await createPreAuthSession(next));
    
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'))
      .mockResolvedValueOnce(Response.json({ response: { players: [{ steamid: steamId, personaname: 'test', profileurl: `https://steamcommunity.com/profiles/${steamId}`, avatarfull: '', avatarmedium: '', communityvisibilitystate: 3 }] } }));
    ensureUser.mockResolvedValue(undefined);

    const params = new URLSearchParams({
      'openid.ns': OPENID_NAMESPACE, 'openid.mode': 'id_res',
      'openid.op_endpoint': OPENID_ENDPOINT, 'openid.return_to': 'https://qit.example/api/auth/steam-callback',
      'openid.claimed_id': `https://steamcommunity.com/openid/id/${steamId}`,
      'openid.identity': `https://steamcommunity.com/openid/id/${steamId}`,
      'openid.signed': 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
      'openid.response_nonce': 'nonce', 'openid.assoc_handle': 'handle', 'openid.sig': 'signature',
    });
    const req = new Request(`https://qit.example/api/auth/steam-callback?${params}`);
    
    const res = await callbackGET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://qit.example/library?autosync=1');
  });
});
