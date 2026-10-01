import { test, expect, vi, beforeEach, afterEach, describe } from 'vitest';
import { isValidNextPath, SESSION_COOKIE, createPreAuthSession } from '../src/lib/session';

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
});

describe('Next path validation', () => {
  test('validates next paths correctly', () => {
    expect(isValidNextPath('/library')).toBe(true);
    expect(isValidNextPath('/library?autosync=1')).toBe(true);
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
  });
});

describe('Steam login and callback next path flow', () => {
  test('steam-login stores valid next path in session cookie', async () => {
    const req = new Request('https://qit.example/api/auth/steam-login?next=/lobby/123');
    const res = await loginGET(req);
    expect(res.status).toBe(307);
    const setCookie = res.cookies.get(SESSION_COOKIE);
    expect(setCookie).toBeDefined();
    expect(setCookie?.value).toBeTruthy();
  });

  test('steam-login ignores invalid next path', async () => {
    const req = new Request('https://qit.example/api/auth/steam-login?next=http://example.com/lobby');
    const res = await loginGET(req);
    expect(res.status).toBe(307);
    const setCookie = res.cookies.get(SESSION_COOKIE);
    expect(setCookie).toBeUndefined();
  });

  test('steam-callback retrieves valid next path and redirects', async () => {
    const steamId = '76561198000000000';
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
  });

  test('steam-callback falls back to library?autosync=1 if next path is missing or invalid', async () => {
    const steamId = '76561198000000000';
    cookieValues.clear();
    
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
