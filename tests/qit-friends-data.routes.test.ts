import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SteamClientError } from '../src/lib/steam/client';
import type { FriendLibrary } from '../src/lib/social/libraries';

const { getSteamId, getFriends, getSteamLibrary, pinPlayer, unpinPlayer } = vi.hoisted(() => ({
  getSteamId: vi.fn(), getFriends: vi.fn(), getSteamLibrary: vi.fn(), pinPlayer: vi.fn(), unpinPlayer: vi.fn(),
}));
vi.mock('../src/lib/auth', () => ({ getSteamId }));
vi.mock('../src/lib/social/friends', () => ({ getFriends }));
vi.mock('../src/lib/social/libraries', () => ({ getSteamLibrary }));
vi.mock('../src/lib/social/pinned', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/social/pinned')>(), pinPlayer, unpinPlayer }));
vi.mock('../src/lib/base-url', () => ({ getBaseUrl: () => 'https://qit.example' }));

import { GET as friendLibrary } from '../src/app/api/games/friend/route';
import { GET as friendsList } from '../src/app/api/steam/friends/route';
import { DELETE as unpin, POST as pin } from '../src/app/api/steam/friends/pinned/route';

const me = '76561198000000001';
const friendId = '76561198000000002';
const target = '76561198000000003';

const library = (state: FriendLibrary['state'], games: FriendLibrary['games'] = new Map()): FriendLibrary =>
  ({ steamId: friendId, state, source: 'steam', games, fetchedAt: 1 });
const friendRequest = (id: string | null = friendId) => new Request(`https://qit.example/api/games/friend${id === null ? '' : `?steamid=${id}`}`);

beforeEach(() => {
  for (const mock of [getSteamId, getFriends, getSteamLibrary, pinPlayer, unpinPlayer]) mock.mockReset();
  getSteamId.mockResolvedValue(me);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/steam/friends', () => {
  it('requires a session before doing anything', async () => {
    getSteamId.mockResolvedValue(null);
    expect((await friendsList()).status).toBe(401);
    expect(getFriends).not.toHaveBeenCalled();
  });

  it('returns the friends result for the signed-in user and is not cacheable', async () => {
    const result = { friends: [{ steamId: friendId, personaName: 'F', profileUrl: 'u', avatarFull: 'a', avatarMedium: 'm', status: 1 }], source: 'friends' };
    getFriends.mockResolvedValue(result);
    const response = await friendsList();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(getFriends).toHaveBeenCalledWith(me);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers 502 with a plain message when the lookup fails', async () => {
    getFriends.mockRejectedValue(new SteamClientError('unavailable', 500));
    const response = await friendsList();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Could not load Steam friends. Please try again.' });
  });
});

describe('GET /api/games/friend', () => {
  it('requires a session, and validates the id, before reading anything', async () => {
    getSteamId.mockResolvedValueOnce(null);
    expect((await friendLibrary(friendRequest())).status).toBe(401);
    expect((await friendLibrary(friendRequest(null))).status).toBe(400);
    expect((await friendLibrary(friendRequest('123'))).status).toBe(400);
    expect(getSteamLibrary).not.toHaveBeenCalled();
  });

  it('returns the games in the shape the library page reads', async () => {
    getSteamLibrary.mockResolvedValue(library('ok', new Map([[620, { n: 'Portal 2', i: 'abc', p: 120 }], [730, { n: 'CS2' }]])));
    const response = await friendLibrary(friendRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ games: [
      { appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 120 },
      { appid: 730, name: 'CS2', img_icon_url: '', playtime_forever: 0 },
    ] });
    expect(getSteamLibrary).toHaveBeenCalledWith(friendId);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it.each([
    ['not_found', 404, /not found/i],
    ['private', 403, /private/i],
    ['error', 502, /try again/i],
  ] as const)('maps a %s library to %i', async (state, status, message) => {
    getSteamLibrary.mockResolvedValue(library(state));
    const response = await friendLibrary(friendRequest());
    expect(response.status).toBe(status);
    expect((await response.json()).error).toMatch(message);
  });

  it('answers 502 when the lookup throws', async () => {
    getSteamLibrary.mockRejectedValue(new Error('boom'));
    expect((await friendLibrary(friendRequest())).status).toBe(502);
  });

  it('limits each user to a burst of 20 lookups and then one every three seconds', async () => {
    getSteamId.mockResolvedValue('76561198000000077');
    getSteamLibrary.mockResolvedValue(library('ok'));
    for (let i = 0; i < 20; i++) expect((await friendLibrary(friendRequest())).status).toBe(200);
    const limited = await friendLibrary(friendRequest());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: expect.stringMatching(/too many/i) });
    expect(getSteamLibrary).toHaveBeenCalledTimes(20);
    // Another user is unaffected.
    getSteamId.mockResolvedValue('76561198000000078');
    expect((await friendLibrary(friendRequest())).status).toBe(200);
  });
});

describe('/api/steam/friends/pinned', () => {
  // Limiter state lives for the whole file, so every test is a different user on a different address.
  let seq = 0;
  beforeEach(() => { seq++; getSteamId.mockResolvedValue(`76561198000${String(10000 + seq)}`); });
  const headersFor = (extra: Record<string, string> = {}) => ({ origin: 'https://qit.example', 'x-forwarded-for': `203.0.113.${seq}`, ...extra });
  const post = (body: unknown, headers: Record<string, string> = headersFor()) =>
    new Request('https://qit.example/api/steam/friends/pinned', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const del = (id: string | null = target, headers: Record<string, string> = headersFor()) =>
    new Request(`https://qit.example/api/steam/friends/pinned${id === null ? '' : `?steamid=${id}`}`, { method: 'DELETE', headers });

  it('needs a session and a same-origin request for both methods', async () => {
    getSteamId.mockResolvedValueOnce(null);
    expect((await pin(post({ player: 'x' }))).status).toBe(401);
    expect((await pin(post({ player: 'x' }, headersFor({ origin: 'https://evil.example' })))).status).toBe(403);
    expect((await unpin(del(target, headersFor({ origin: 'https://evil.example' })))).status).toBe(403);
    expect(pinPlayer).not.toHaveBeenCalled();
    expect(unpinPlayer).not.toHaveBeenCalled();
  });

  it('pins a player and returns the player and the pinned ids', async () => {
    const player = { steamId: target, personaName: 'P', profileUrl: 'u', avatarFull: 'a', avatarMedium: 'm' };
    pinPlayer.mockResolvedValue({ ok: true, player, pinned: [target] });
    const response = await pin(post({ player: ' https://steamcommunity.com/id/gabe ' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ player, pinned: [target] });
    expect(pinPlayer).toHaveBeenCalledWith(expect.stringMatching(/^76561198000/), ' https://steamcommunity.com/id/gabe ');
  });

  it.each(['{', 'null', '{}', '{"player":5}', '{"player":"   "}', `{"player":"${'a'.repeat(201)}"}`])('rejects a bad body: %s', async body => {
    const response = await pin(post(body));
    expect(response.status).toBe(400);
    expect(pinPlayer).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', /not found/i], ['self', /own profile/i], ['limit', /up to 50/i], ['invalid', /profile URL/i],
  ] as const)('explains a %s failure', async (reason, message) => {
    pinPlayer.mockResolvedValue({ ok: false, reason });
    const response = await pin(post({ player: 'x' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: 'invalid', message: expect.stringMatching(message) });
  });

  it('answers 502 when Steam fails', async () => {
    pinPlayer.mockRejectedValue(new SteamClientError('rate_limited', 429));
    expect((await pin(post({ player: 'x' }))).status).toBe(502);
  });

  it('unpins by Steam ID', async () => {
    unpinPlayer.mockResolvedValue([]);
    const response = await unpin(del());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pinned: [] });
    expect(unpinPlayer).toHaveBeenCalledWith(expect.stringMatching(/^76561198000/), target);
    expect((await unpin(del(null))).status).toBe(400);
    expect((await unpin(del('abc'))).status).toBe(400);
  });

  it('rate limits a user who keeps adding players', async () => {
    pinPlayer.mockResolvedValue({ ok: false, reason: 'not_found' });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await pin(post({ player: 'x' }))).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
