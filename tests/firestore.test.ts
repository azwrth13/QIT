import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { db } from '../src/lib/firestore';
import { getStoredGames, getStoredProfile, ownsGames, syncLibrary } from '../src/lib/library-data';
import { getGenresForApps } from '../src/lib/genre-cache';
import { getCachedAchievementProgress } from '../src/lib/achievement-cache';
import type { SteamProfile } from '../src/lib/steam';

const steamId = '76561198000000042';
const profile: SteamProfile = {
  steamId, personaName: 'Test player', profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
  avatarFull: 'https://example.test/full.jpg', avatarMedium: 'https://example.test/medium.jpg', public: true,
};

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with the Firestore emulator');
  process.env.STEAM_API_KEY = 'emulator-test-key';
});
afterAll(() => { vi.unstubAllGlobals(); });

it('syncs insert, update, and delete, keeps genres off the library load, and shares the genre cache between libraries', async () => {
  let games = [
    { appid: 100001, name: 'First', playtime_forever: 5 },
    { appid: 100002, name: 'Second', playtime_forever: 10 },
  ];
  let storeCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
    if (String(url).includes('GetOwnedGames')) return Response.json({ response: { games } });
    if (String(url).includes('appdetails')) {
      storeCalls++;
      const id = new URL(String(url)).searchParams.get('appids');
      return Response.json({ [id!]: { success: true, data: { genres: [{ description: 'Action' }] } } });
    }
    throw new Error('Unexpected request');
  }));

  const first = await syncLibrary(steamId, profile);
  expect(first?.games).toHaveLength(2);
  expect(first?.games[0].genres).toBeUndefined();
  expect((await getStoredGames(steamId))[0].genres).toBeUndefined();
  expect(storeCalls).toBe(0);
  expect((await getStoredProfile(steamId))?.personaName).toBe('Test player');
  expect(await ownsGames(steamId, [100001, 100002])).toBe(true);
  expect(await ownsGames(steamId, [100001, 100003])).toBe(false);
  expect(await getGenresForApps([100001, 100002])).toEqual({ 100001: ['Action'], 100002: ['Action'] });
  expect(storeCalls).toBe(2);

  games = [
    { appid: 100001, name: 'First renamed', playtime_forever: 25 },
    { appid: 100003, name: 'Third', playtime_forever: 0 },
  ];
  const second = await syncLibrary(steamId, profile);
  expect(second?.lastSynced).toBeTruthy();
  expect(storeCalls).toBe(2);
  expect((await getStoredGames(steamId)).map(game => game.appid).sort()).toEqual([100001, 100003]);
  expect((await db.doc(`users/${steamId}/games/100001`).get()).data()?.name).toBe('First renamed');
  expect((await db.doc(`users/${steamId}/games/100002`).get()).exists).toBe(false);
  expect(await getGenresForApps([100001])).toEqual({ 100001: ['Action'] });
  expect(storeCalls).toBe(2);
});

it('caches Steam no-stats and private achievement responses but not other failures', async () => {
  let status = 400;
  let body: unknown = { playerstats: { success: false, error: 'Requested app has no stats' } };
  let steamCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
    if (!String(url).includes('GetPlayerAchievements')) throw new Error('Unexpected request');
    steamCalls++;
    return Response.json(body, { status });
  }));

  expect(await getCachedAchievementProgress(steamId, 200001)).toBeNull();
  expect(await getCachedAchievementProgress(steamId, 200001)).toBeNull();
  expect(steamCalls).toBe(1);

  status = 403;
  body = { playerstats: { success: false, error: 'Profile is not public' } };
  expect(await getCachedAchievementProgress(steamId, 200002)).toBeNull();
  expect(await getCachedAchievementProgress(steamId, 200002)).toBeNull();
  expect(steamCalls).toBe(2);

  for (const [appid, nextStatus] of [[200003, 500], [200004, 403]]) {
    status = nextStatus;
    body = { error: 'Forbidden' };
    await expect(getCachedAchievementProgress(steamId, appid)).rejects.toThrow('Steam request failed');
    expect((await db.doc(`users/${steamId}/achievementProgress/${appid}`).get()).exists).toBe(false);
  }
});

it('returns fetched achievement progress when the cache write fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ playerstats: { success: true, achievements: [{ achieved: 1 }, { achieved: 0 }] } })));
  const ref = db.doc(`users/${steamId}/achievementProgress/200005`);
  const set = vi.spyOn(Object.getPrototypeOf(ref), 'set').mockRejectedValueOnce(new Error('write failed'));
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await getCachedAchievementProgress(steamId, 200005)).toEqual({ unlocked: 1, total: 2, percent: 50 });
    expect(logged).toHaveBeenCalledWith('Achievement cache write failed', { name: 'Error' });
    expect((await ref.get()).exists).toBe(false);
  } finally {
    set.mockRestore();
    logged.mockRestore();
  }
});
