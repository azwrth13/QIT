import { afterEach, expect, it, vi } from 'vitest';
import { getLibraryStats, pickGame } from '../src/lib/games';
import { getPublicLibrary, getPublicLibraryResponse, makeRoom } from '../src/lib/steam';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const stubSteam = (handler: (url: string) => Response | Promise<Response>) => {
  vi.stubEnv('STEAM_API_KEY', 'test-key');
  vi.stubGlobal('fetch', async (url: URL | string) => handler(String(url)));
};

it('picker never falls back to full library when filters have no matches', () => {
  const allGames = [{ appid: 1, name: 'One' }];
  const filtered = allGames.filter(game => game.name.includes('missing'));
  expect(pickGame(filtered, () => 0)).toBeNull();
  expect(pickGame(allGames, () => 0)?.appid).toBe(1);
});

it('library stats totals playtime and reports unplayed share and most-played game', () => {
  const stats = getLibraryStats([
    { appid: 1, name: 'One', playtime_forever: 120 },
    { appid: 2, name: 'Two', playtime_forever: 30 },
    { appid: 3, name: 'Three' },
    { appid: 4, name: 'Four', playtime_forever: 0 },
  ]);
  expect(stats).toEqual({
    totalHours: 3,
    unplayedCount: 2,
    unplayedPercentage: 50,
    mostPlayed: { game: { appid: 1, name: 'One', playtime_forever: 120 }, hours: 2 },
  });
});

it('library stats handle empty and entirely unplayed libraries', () => {
  expect(getLibraryStats([])).toEqual({ totalHours: 0, unplayedCount: 0, unplayedPercentage: 0, mostPlayed: null });
  expect(getLibraryStats([{ appid: 1, name: 'One' }])).toEqual({
    totalHours: 0, unplayedCount: 1, unplayedPercentage: 100, mostPlayed: null,
  });
});

it('private Steam profile does not request or reveal owned games', async () => {
  let gameRequests = 0;
  stubSteam(url => {
    if (url.includes('GetOwnedGames')) gameRequests++;
    return new Response(JSON.stringify({ response: { players: [{ steamid: '76561198000000000', personaname: 'Private', profileurl: 'https://steamcommunity.com/profiles/76561198000000000', avatarfull: '', avatarmedium: '', communityvisibilitystate: 1 }] } }), { status: 200 });
  });
  const library = await getPublicLibrary('76561198000000000');
  expect(library.state).toBe('private');
  expect(library.games).toEqual([]);
  expect(gameRequests).toBe(0);
});

it('public profile with zero owned games is empty rather than private', async () => {
  stubSteam(url => new Response(JSON.stringify(url.includes('GetOwnedGames')
    ? { response: { game_count: 0 } }
    : { response: { players: [{ steamid: '76561198000000000', personaname: 'Empty', profileurl: '', avatarfull: '', avatarmedium: '', communityvisibilitystate: 3 }] } }), { status: 200 }));
  const library = await getPublicLibrary('76561198000000000');
  expect(library.state).toBe('public');
  expect(library.games).toEqual([]);
});

it('public library route validates ids, caches per Steam ID, and rate limits per IP', async () => {
  let steamRequests = 0;
  stubSteam(() => {
    steamRequests++;
    return new Response(JSON.stringify({ response: { players: [] } }), { status: 200 });
  });
  const invalid = await getPublicLibraryResponse('123', '10.0.0.1', 0);
  expect(invalid.status).toBe(400);
  expect(steamRequests).toBe(0);

  const unknown = await getPublicLibraryResponse('76561198000000001', '10.0.0.1', 0);
  expect(unknown.status).toBe(404);
  expect(unknown.body).toMatchObject({ message: expect.stringMatching(/not found/) });
  expect(steamRequests).toBe(1);

  for (let i = 1; i < 20; i++) await getPublicLibraryResponse('76561198000000001', '10.0.0.1', 1000);
  expect(steamRequests).toBe(1);
  const limited = await getPublicLibraryResponse('76561198000000001', '10.0.0.1', 1000);
  expect(limited.status).toBe(429);
  expect(limited.retryAfter).toBe(59);
  expect((await getPublicLibraryResponse('76561198000000001', '10.0.0.2', 1000)).status).toBe(404);

  await getPublicLibraryResponse('76561198000000001', '10.0.0.1', 5 * 60 * 1000 + 1);
  expect(steamRequests).toBe(2);
});

it('concurrent public library lookups for one Steam ID share a single Steam request', async () => {
  let steamRequests = 0;
  stubSteam(async () => {
    steamRequests++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ response: { players: [] } }), { status: 200 });
  });
  const results = await Promise.all([1, 2, 3].map(n => getPublicLibraryResponse('76561198000000002', `10.1.0.${n}`, 0)));
  expect(results.map(result => result.status)).toEqual([404, 404, 404]);
  expect(steamRequests).toBe(1);
});

it('makeRoom drops expired entries first, then the oldest, to stay under the cap', () => {
  const cache = new Map([[1, { expires: 50 }], [2, { expires: 500 }], [3, { expires: 10 }], [4, { expires: 900 }]]);
  makeRoom(cache, entry => entry.expires, 100, 4);
  expect([...cache.keys()]).toEqual([2, 4]);
  cache.set(5, { expires: 900 }).set(6, { expires: 900 });
  makeRoom(cache, entry => entry.expires, 100, 3);
  expect([...cache.keys()]).toEqual([5, 6]);
});
