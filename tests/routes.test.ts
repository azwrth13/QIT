import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, SESSION_COOKIE } from '../src/lib/session';

const { cookieValues, getStoredGames, getLastSyncedAt, getStoredProfile, ensureUser, ownsGames, getGenresForApps, getCachedAchievementProgress } = vi.hoisted(() => ({
  cookieValues: new Map<string, string>(), getStoredGames: vi.fn(), getLastSyncedAt: vi.fn(),
  getStoredProfile: vi.fn(), ensureUser: vi.fn(), ownsGames: vi.fn(), getGenresForApps: vi.fn(), getCachedAchievementProgress: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({
  get: (name: string) => cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined,
}) }));
vi.mock('../src/lib/library-data', () => ({ AUTO_SYNC_COOKIE: 'library-autosync', getStoredGames, getLastSyncedAt, getStoredProfile, ensureUser, ownsGames }));
vi.mock('../src/lib/genre-cache', () => ({ getGenresForApps }));
vi.mock('../src/lib/achievement-cache', () => ({ getCachedAchievementProgress }));

import { GET as callback } from '../src/app/api/auth/steam-callback/route';
import { verifySession } from '../src/lib/session';
import { OPENID_ENDPOINT, OPENID_NAMESPACE } from '../src/lib/steam';

import { GET as games } from '../src/app/api/games/route';
import { GET as profile } from '../src/app/api/user/profile/route';
import { GET as friend } from '../src/app/api/games/friend/route';
import { GET as search } from '../src/app/api/steam/search/route';
import { GET as friends } from '../src/app/api/steam/friends/route';
import { POST as genres } from '../src/app/api/games/genres/route';
import { GET as achievements } from '../src/app/api/games/achievements/route';

const steamId = '76561198000000000';
const request = (body: string) => new Request('https://qit.example/api/games/genres', { method: 'POST', body });

beforeEach(() => {
  cookieValues.clear();
  getStoredGames.mockReset();
  getLastSyncedAt.mockReset();
  getStoredProfile.mockReset();
  ensureUser.mockReset();
  ownsGames.mockReset();
  getGenresForApps.mockReset();
  getCachedAchievementProgress.mockReset();
  getStoredGames.mockResolvedValue([]);
  getLastSyncedAt.mockResolvedValue(null);
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
    expect(getStoredGames).not.toHaveBeenCalled();
    expect(ownsGames).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('looks up games using the verified session identity', async () => {
    cookieValues.set(SESSION_COOKIE, await createSession(steamId));
    getStoredGames.mockResolvedValue([{ appid: 10 }]);
    const response = await games();
    expect(response.status).toBe(200);
    expect(getStoredGames).toHaveBeenCalledWith(steamId);
  });
});

describe('post-login auto sync', () => {
  beforeEach(async () => { cookieValues.set(SESSION_COOKIE, await createSession(steamId)); });
  it('requests one sync after sign-in and consumes the flag', async () => {
    getLastSyncedAt.mockResolvedValue('2026-01-01T00:00:00.000Z');
    cookieValues.set('library-autosync', '1');
    getStoredGames.mockResolvedValue([{ appid: 10 }]);
    const first = await games();
    expect(await first.json()).toMatchObject({ autoSync: true, lastSynced: '2026-01-01T00:00:00.000Z' });
    expect(first.cookies.get('library-autosync')).toMatchObject({ value: '', maxAge: 0 });
    cookieValues.delete('library-autosync');
    const second = await games();
    expect(await second.json()).toMatchObject({ autoSync: false });
    expect(second.cookies.get('library-autosync')).toBeUndefined();
  });
  it('requests a sync for a never-synced empty library but not for a synced empty one', async () => {
    getStoredGames.mockResolvedValue([]);
    expect(await (await games()).json()).toMatchObject({ autoSync: true, lastSynced: null });
    getLastSyncedAt.mockResolvedValue('2026-01-01T00:00:00.000Z');
    expect(await (await games()).json()).toMatchObject({ autoSync: false });
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

describe('Steam friend suggestions', () => {
  beforeEach(() => vi.stubEnv('STEAM_API_KEY', 'test-key'));
  it('requires a signed session before requesting Steam', async () => {
    expect((await friends()).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('explains a private friends list without returning an error', async () => {
    cookieValues.set(SESSION_COOKIE, await createSession(steamId));
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }));
    const response = await friends();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ friends: [], message: expect.stringMatching(/private/i) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('maps friends to search result profiles and caches per signed-in user', async () => {
    const owner = '76561198000000002';
    const friendId = '76561198000000003';
    cookieValues.set(SESSION_COOKIE, await createSession(owner));
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ friendslist: { friends: [{ steamid: friendId }] } }))
      .mockResolvedValueOnce(Response.json({ response: { players: [{ steamid: friendId, personaname: 'Friend', profileurl: `https://steamcommunity.com/profiles/${friendId}`, avatarfull: 'https://example.com/full.jpg', avatarmedium: 'https://example.com/medium.jpg' }] } }));
    for (let i = 0; i < 2; i++) {
      const response = await friends();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ friends: [{ steamId: friendId, personaName: 'Friend', profileUrl: `https://steamcommunity.com/profiles/${friendId}`, avatarFull: 'https://example.com/full.jpg', avatarMedium: 'https://example.com/medium.jpg' }] });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).searchParams.get('steamid')).toBe(owner);
    expect(new URL(String(vi.mocked(fetch).mock.calls[1][0])).searchParams.get('steamids')).toBe(friendId);
  });
  it('batches more than 100 friends for player summaries', async () => {
    const owner = '76561198000000004';
    cookieValues.set(SESSION_COOKIE, await createSession(owner));
    const ids = Array.from({ length: 101 }, (_, index) => `76561198${String(index + 100).padStart(9, '0')}`);
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ friendslist: { friends: ids.map(steamid => ({ steamid })) } }))
      .mockResolvedValueOnce(Response.json({ response: { players: ids.slice(0, 100).map(steamid => ({ steamid, personaname: steamid, profileurl: '', avatarfull: '' })) } }))
      .mockResolvedValueOnce(Response.json({ response: { players: [{ steamid: ids[100], personaname: ids[100], profileurl: '', avatarfull: '' }] } }));
    expect((await (await friends()).json()).friends).toHaveLength(101);
    expect(vi.mocked(fetch).mock.calls.slice(1).map(([url]) => new URL(String(url)).searchParams.get('steamids')?.split(',').length)).toEqual([100, 1]);
  });
});

describe('genre request validation', () => {
  beforeEach(async () => cookieValues.set(SESSION_COOKIE, await createSession(steamId)));
  it.each(['{', 'null', '{}', '{"appids":["10"]}', '{"appids":[10,10]}'])('returns 400 on malformed input: %s', async body => {
    expect((await genres(request(body))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects unowned IDs without looking up genres', async () => {
    ownsGames.mockResolvedValue(false);
    expect((await genres(request('{"appids":[10,20]}'))).status).toBe(400);
    expect(ownsGames).toHaveBeenCalledWith(steamId, [10, 20]);
    expect(getStoredGames).not.toHaveBeenCalled();
    expect(getGenresForApps).not.toHaveBeenCalled();
  });
  it('fetches genres for an owned game', async () => {
    ownsGames.mockResolvedValue(true);
    getGenresForApps.mockResolvedValue({ 10: ['Action'] });
    const response = await genres(request('{"appids":[10]}'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ genres: { '10': ['Action'] }, successCount: 1, errorCount: 0, totalRequested: 1 });
    expect(getGenresForApps).toHaveBeenCalledWith([10]);
  });
});

describe('achievement progress route', () => {
  const achievementRequest = (appid = '10') => new Request(`https://qit.example/api/games/achievements?appid=${appid}`);
  beforeEach(async () => {
    cookieValues.set(SESSION_COOKIE, await createSession(steamId));
    ownsGames.mockResolvedValue(true);
  });
  it('requires a verified signed-in session', async () => {
    cookieValues.clear();
    expect((await achievements(achievementRequest())).status).toBe(401);
    expect(ownsGames).not.toHaveBeenCalled();
  });
  it('rejects invalid IDs and games outside the signed-in user library', async () => {
    expect((await achievements(achievementRequest('1.2'))).status).toBe(400);
    ownsGames.mockResolvedValue(false);
    expect((await achievements(achievementRequest())).status).toBe(400);
    expect(getCachedAchievementProgress).not.toHaveBeenCalled();
  });
  it.each(['no achievements', 'private stats'])('quietly returns no progress for %s', async () => {
    getCachedAchievementProgress.mockResolvedValue(null);
    const response = await achievements(achievementRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ progress: null });
  });
  it('returns mapped progress for an owned game', async () => {
    getCachedAchievementProgress.mockResolvedValue({ unlocked: 6, total: 10, percent: 60 });
    const response = await achievements(achievementRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ progress: { unlocked: 6, total: 10, percent: 60 } });
    expect(ownsGames).toHaveBeenCalledWith(steamId, [10]);
    expect(getCachedAchievementProgress).toHaveBeenCalledWith(steamId, 10);
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
    const response = await callback(callbackRequest('https://other.example/callback'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('login_error=invalid_steam_id');
    expect(fetch).not.toHaveBeenCalled();
    expect(ensureUser).not.toHaveBeenCalled();
  });
  it('rejects a Steam verification failure without issuing a session', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('is_valid:false\n'));
    const response = await callback(callbackRequest());
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('login_error=verification_failed');
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(ensureUser).not.toHaveBeenCalled();
  });
  it('issues a verifiable session only after successful Steam verification', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'))
      .mockResolvedValueOnce(Response.json({ response: { players: [{ steamid: steamId, profileurl: `https://steamcommunity.com/profiles/${steamId}` }] } }));
    ensureUser.mockResolvedValue(undefined);
    const response = await callback(callbackRequest());
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://qit.example/library');
    const session = response.cookies.get(SESSION_COOKIE);
    expect(await verifySession(session?.value)).toBe(steamId);
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(response.cookies.get('library-autosync')?.value).toBe('1');
    expect(response.cookies.get('library-synced')).toBeUndefined();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(OPENID_ENDPOINT);
    const verificationBody = vi.mocked(fetch).mock.calls[0][1]?.body;
    expect(verificationBody).toBeInstanceOf(URLSearchParams);
    expect((verificationBody as URLSearchParams).getAll('openid.mode')).toEqual(['check_authentication']);
  });
});
