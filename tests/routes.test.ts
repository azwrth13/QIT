import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, SESSION_COOKIE } from '../src/lib/session';

const { cookieValues, findUnique, upsert } = vi.hoisted(() => ({
  cookieValues: new Map<string, string>(), findUnique: vi.fn(), upsert: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({
  get: (name: string) => cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined,
}) }));
vi.mock('../src/app/library/prisma', () => ({ default: { user: { findUnique, upsert } } }));

import { GET as callback } from '../src/app/api/auth/steam-callback/route';
import { verifySession } from '../src/lib/session';
import { OPENID_ENDPOINT, OPENID_NAMESPACE } from '../src/lib/steam';

import { GET as games } from '../src/app/api/games/route';
import { GET as profile } from '../src/app/api/user/profile/route';
import { GET as friend } from '../src/app/api/games/friend/route';
import { GET as search } from '../src/app/api/steam/search/route';
import { POST as genres } from '../src/app/api/games/genres/route';

const steamId = '76561198000000000';
const request = (body: string) => new Request('https://qit.example/api/games/genres', { method: 'POST', body });

beforeEach(() => {
  cookieValues.clear();
  findUnique.mockReset();
  upsert.mockReset();
  vi.stubEnv('SESSION_SECRET', 'test-only-secret-with-at-least-32-characters');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('route authentication', () => {
  it.each(['missing', 'unsigned', 'forged'])('rejects %s credentials before DB or Steam calls', async credential => {
    if (credential === 'unsigned') cookieValues.set('steamid', steamId);
    if (credential === 'forged') cookieValues.set(SESSION_COOKIE, steamId);
    const responses = await Promise.all([
      games(), profile(), friend(new Request(`https://qit.example/api/games/friend?steamid=${steamId}`)),
      genres(request('{"appids":[10]}')),
    ]);
    expect(responses.map(response => response.status)).toEqual([401, 401, 401, 401]);
    expect(findUnique).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('looks up games using the verified session identity', async () => {
    cookieValues.set(SESSION_COOKIE, await createSession(steamId));
    findUnique.mockResolvedValue({ games: [{ appid: 10 }] });
    const response = await games();
    expect(response.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { steamId }, include: { games: true } });
  });
});

describe('public profile search', () => {
  const searchRequest = (q: string, ip: string) => new Request(`https://qit.example/api/steam/search?${new URLSearchParams({ q })}`, { headers: { 'x-forwarded-for': ip } });
  const player = (id: string) => Response.json({ response: { players: [{ steamid: id, personaname: 'Player', profileurl: `https://steamcommunity.com/profiles/${id}` }] } });
  beforeEach(() => vi.stubEnv('STEAM_API_KEY', 'test-key'));
  it('resolves a vanity name for a signed-out visitor and caches the result', async () => {
    const id = '76561198000000001';
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ response: { steamid: id } })).mockResolvedValueOnce(player(id));
    for (let i = 0; i < 2; i++) {
      const response = await search(searchRequest('cached-name', '203.0.113.1'));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ steamId: id, personaName: 'Player' });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).searchParams.get('vanityurl')).toBe('cached-name');
  });
  it('rejects invalid input before calling Steam', async () => {
    for (const q of ['', 'a'.repeat(257), 'name&key=x', 'https://evil.example/id/name']) {
      expect((await search(searchRequest(q, '203.0.113.2'))).status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns a friendly 429 after 20 requests per minute from one IP', async () => {
    const responses = [];
    for (let i = 0; i < 21; i++) responses.push(await search(searchRequest('bad input', '203.0.113.3')));
    expect(responses.slice(0, 20).every(response => response.status === 400)).toBe(true);
    expect(responses[20].status).toBe(429);
    expect((await responses[20].json()).error).toMatch(/try again/);
    expect((await search(searchRequest('bad input', '203.0.113.4'))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keys the limit on the load-balancer-appended client IP, ignoring client-supplied forwarded entries', async () => {
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await search(searchRequest('bad input', `198.51.100.${i}, 203.0.113.5, 35.191.0.1`))).status);
    expect(statuses.at(-1)).toBe(429);
    expect((await search(searchRequest('bad input', '203.0.113.7, 35.191.0.1'))).status).toBe(400);
  });
  it('keeps live counters when the limiter fills with other clients', async () => {
    vi.resetModules();
    const { GET: freshSearch } = await import('../src/app/api/steam/search/route');
    const other = (i: number) => freshSearch(searchRequest('bad input', `10.${i >> 8}.${i & 255}.1`));
    for (let i = 0; i < 5_000; i++) await other(i);
    for (let i = 0; i < 20; i++) await freshSearch(searchRequest('bad input', '203.0.113.6'));
    for (let i = 5_000; i < 10_001; i++) await other(i);
    expect((await freshSearch(searchRequest('bad input', '203.0.113.6'))).status).toBe(429);
  });
});

describe('genre request validation', () => {
  beforeEach(async () => cookieValues.set(SESSION_COOKIE, await createSession(steamId)));
  it.each(['{', 'null', '{}', '{"appids":["10"]}', '{"appids":[10,10]}'])('returns 400 on malformed input: %s', async body => {
    expect((await genres(request(body))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects requests larger than the caller library and unowned IDs', async () => {
    findUnique.mockResolvedValue({ games: [{ appid: 10 }] });
    expect((await genres(request('{"appids":[10,20]}'))).status).toBe(400);
    expect((await genres(request('{"appids":[20]}'))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fetches genres for an owned game', async () => {
    findUnique.mockResolvedValue({ games: [{ appid: 10 }] });
    vi.mocked(fetch).mockResolvedValue(Response.json({ '10': { data: { genres: [{ description: 'Action' }] } } }));
    const response = await genres(request('{"appids":[10]}'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ genres: { '10': ['Action'] }, successCount: 1, errorCount: 0, totalRequested: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('OpenID callback route', () => {
  function callbackRequest(returnTo = 'https://qit.example/api/auth/steam-callback') {
    const params = new URLSearchParams({
      'openid.ns': OPENID_NAMESPACE, 'openid.mode': 'id_res',
      'openid.op_endpoint': OPENID_ENDPOINT, 'openid.return_to': returnTo,
      'openid.claimed_id': `https://steamcommunity.com/openid/id/${steamId}`,
      'openid.identity': `https://steamcommunity.com/openid/id/${steamId}`,
      'openid.signed': 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
      'openid.response_nonce': 'nonce', 'openid.assoc_handle': 'handle', 'openid.sig': 'signature',
    });
    return new Request(`https://qit.example/api/auth/steam-callback?${params}`);
  }
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.example');
    vi.stubEnv('STEAM_API_KEY', 'test-key');
  });
  it('rejects another site assertion before verification', async () => {
    expect((await callback(callbackRequest('https://other.example/callback'))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
  it('rejects a Steam verification failure without issuing a session', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('is_valid:false\n'));
    const response = await callback(callbackRequest());
    expect(response.status).toBe(401);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
  });
  it('issues a verifiable session only after successful Steam verification', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'))
      .mockResolvedValueOnce(Response.json({ response: { players: [{ steamid: steamId, profileurl: `https://steamcommunity.com/profiles/${steamId}` }] } }))
      .mockResolvedValueOnce(Response.json({ response: { games: [] } }));
    upsert.mockResolvedValue({ id: 1 });
    const response = await callback(callbackRequest());
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://qit.example/library');
    const session = response.cookies.get(SESSION_COOKIE);
    expect(await verifySession(session?.value)).toBe(steamId);
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(OPENID_ENDPOINT);
    const verificationBody = vi.mocked(fetch).mock.calls[0][1]?.body;
    expect(verificationBody).toBeInstanceOf(URLSearchParams);
    expect((verificationBody as URLSearchParams).getAll('openid.mode')).toEqual(['check_authentication']);
  });
});
