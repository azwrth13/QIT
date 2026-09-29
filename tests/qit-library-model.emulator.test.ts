import { Query } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/firestore';
import { getLibrary, ownsGames as ownsLibraryGames } from '../src/lib/library';
import { getStoredGames, ownsGames, syncLibrary } from '../src/lib/library-data';
import type { SteamProfile } from '../src/lib/steam';
import { libIndexChunkOf, patchLibIndex, readLibIndex } from '../src/lib/store/lib-index';
import { paths } from '../src/lib/store/paths';

// Emulator-only (npm run test:firestore). Skipped elsewhere so it can never touch a real project.
const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;

let nextId = 0;
const freshUser = () => `7656119800${String(Date.now() % 1e5).padStart(5, '0')}${String(nextId++ % 100).padStart(2, '0')}`;
const profileOf = (steamId: string): SteamProfile => ({
  steamId, personaName: 'Library tester', profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
  avatarFull: 'https://example.test/full.jpg', avatarMedium: 'https://example.test/medium.jpg', public: true,
});

type SteamGame = Record<string, unknown> & { appid: number };
let steamGames: SteamGame[] | null = [];
let ownedGamesUrls: URL[] = [];
let otherRequests = 0;

beforeEach(() => {
  vi.stubEnv('STEAM_API_KEY', 'emulator-test-key');
  steamGames = [];
  ownedGamesUrls = [];
  otherRequests = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    if (!url.pathname.includes('GetOwnedGames')) { otherRequests++; throw new Error('Unexpected request'); }
    ownedGamesUrls.push(url);
    return Response.json({ response: steamGames === null ? {} : { game_count: steamGames.length, games: steamGames } });
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function countReads() {
  let reads = 0;
  const getAll = db.getAll.bind(db);
  vi.spyOn(db, 'getAll').mockImplementation((...refs) => { reads += refs.length; return getAll(...refs); });
  // DocumentReference.get goes through db.getAll, so it is counted there.
  const queryGet = Query.prototype.get;
  vi.spyOn(Query.prototype, 'get').mockImplementation(async function (this: Query) {
    const snapshot = await queryGet.call(this);
    reads += Math.max(1, snapshot.size);
    return snapshot;
  });
  return () => reads;
}

const chunkUpdateTimes = async (steamId: string) =>
  Promise.all([0, 1, 2, 3].map(async chunk => (await db.doc(paths.libIndexChunk(steamId, chunk)).get()).updateTime?.toMillis() ?? null));

describe.skipIf(!emulated)('library model (emulator)', () => {
  it('syncs Steam games into per-game documents and the index, then loads the library from the index alone', async () => {
    const steamId = freshUser();
    steamGames = [
      { appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 90, playtime_2weeks: 30, rtime_last_played: 1_700_000_000, has_community_visible_stats: true },
      { appid: 440, name: 'Team Fortress 2', img_icon_url: 'def', playtime_forever: 0, rtime_last_played: 0 },
      { appid: 70, name: 'Half-Life', playtime_forever: 12 },
    ];
    const result = await syncLibrary(steamId, profileOf(steamId));
    expect(ownedGamesUrls[0].searchParams.get('include_played_free_games')).toBe('1');
    expect(result?.playtimeHidden).toBe(false);
    expect(result?.games.map(game => game.appid)).toEqual([70, 440, 620]);

    expect((await db.doc(paths.userGame(steamId, 620)).get()).data()).toEqual({
      appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 90, playtime_2weeks: 30,
      rtime_last_played: 1_700_000_000, has_community_visible_stats: true,
    });
    expect((await db.doc(paths.userGame(steamId, 70)).get()).data()?.rtime_last_played).toBeNull();
    const { entries } = await readLibIndex(steamId);
    expect(Object.fromEntries(entries)).toEqual({
      620: { n: 'Portal 2', i: 'abc', p: 90, w: 30, r: 1_700_000_000, s: 1 },
      440: { n: 'Team Fortress 2', i: 'def', p: 0, w: 0, r: 0, s: 0 },
      70: { n: 'Half-Life', i: '', p: 12, w: 0, s: 0 },
    });

    let reads = countReads();
    const stored = await getStoredGames(steamId);
    expect(reads()).toBe(4);
    expect(stored).toEqual(result?.games);
    expect(stored.find(game => game.appid === 70)?.rtime_last_played).toBeNull();
    expect(stored.find(game => game.appid === 440)?.rtime_last_played).toBe(0);
    vi.restoreAllMocks();

    reads = countReads();
    const library = await getLibrary(steamId);
    expect(reads()).toBe(5);
    expect(library).toMatchObject({ source: 'index', playtimeHidden: false, lastSyncedAt: result?.lastSynced, games: stored });
    vi.restoreAllMocks();

    reads = countReads();
    expect(await ownsGames(steamId, [620, 70])).toBe(true);
    expect(await ownsGames(steamId, [620, 10])).toBe(false);
    expect(reads()).toBe(8);
    expect(otherRequests).toBe(0);
  });

  it('keeps other packages\' index fields across syncs, clears fields that became unknown, and removes games no longer owned', async () => {
    const steamId = freshUser();
    steamGames = [
      { appid: 620, name: 'Portal 2', playtime_forever: 90, playtime_2weeks: 30, rtime_last_played: 1_700_000_000 },
      { appid: 400, name: 'Portal', playtime_forever: 5, rtime_last_played: 1_600_000_000 },
    ];
    await syncLibrary(steamId, profileOf(steamId));
    // app-metadata and achievements-data patch their own fields into the same entries.
    expect((await patchLibIndex(steamId, { 620: { f: 3, ap: 50, au: 1, at: 2 }, 400: { f: 1 } })).applied).toHaveLength(2);

    steamGames = [
      { appid: 620, name: 'Portal 2', playtime_forever: 95 },
      { appid: 70, name: 'Half-Life', playtime_forever: 0, rtime_last_played: 0 },
    ];
    await syncLibrary(steamId, profileOf(steamId));
    const { entries } = await readLibIndex(steamId);
    expect(Object.fromEntries(entries)).toEqual({
      620: { n: 'Portal 2', i: '', p: 95, w: 0, s: 0, f: 3, ap: 50, au: 1, at: 2 },
      70: { n: 'Half-Life', i: '', p: 0, w: 0, r: 0, s: 0 },
    });
    expect((await db.doc(paths.userGame(steamId, 400)).get()).exists).toBe(false);
    expect((await db.doc(paths.libIndexChunk(steamId, libIndexChunkOf(400))).get()).data()?.games).not.toHaveProperty('400');

    // A sync with nothing new writes no index chunk.
    const before = await chunkUpdateTimes(steamId);
    await syncLibrary(steamId, profileOf(steamId));
    expect(await chunkUpdateTimes(steamId)).toEqual(before);
  });

  it('serves legacy per-game documents until the first sync builds the index, which then deletes stale ones', async () => {
    const steamId = freshUser();
    await db.doc(paths.user(steamId)).set({ ...profileOf(steamId), lastSyncedAt: '2026-01-01T00:00:00.000Z' });
    await db.doc(paths.userGame(steamId, 620)).set({ appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 90 });
    await db.doc(paths.userGame(steamId, 400)).set({ appid: 400, name: 'Portal', img_icon_url: '', playtime_forever: 5 });

    expect(await getStoredGames(steamId)).toEqual([
      { appid: 400, name: 'Portal', img_icon_url: '', playtime_forever: 5, rtime_last_played: null },
      { appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 90, rtime_last_played: null },
    ]);
    expect(await getLibrary(steamId)).toMatchObject({ source: 'legacy', lastSyncedAt: '2026-01-01T00:00:00.000Z' });
    expect(await ownsGames(steamId, [620, 400])).toBe(true);
    expect(await ownsGames(steamId, [620, 70])).toBe(false);
    expect(await ownsLibraryGames(steamId, [])).toBe(true);

    steamGames = [
      { appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 90, rtime_last_played: 1_700_000_000 },
      { appid: 70, name: 'Half-Life', playtime_forever: 0 },
    ];
    await syncLibrary(steamId, profileOf(steamId));
    expect((await db.doc(paths.userGame(steamId, 400)).get()).exists).toBe(false);
    expect((await db.doc(paths.userGame(steamId, 620)).get()).data()).toMatchObject({ rtime_last_played: 1_700_000_000, playtime_2weeks: 0 });
    const library = await getLibrary(steamId);
    expect(library.source).toBe('index');
    expect(library.games.map(game => game.appid)).toEqual([70, 620]);
    expect(await ownsGames(steamId, [400])).toBe(false);
  });

  it('keeps a library that became empty as built and empty', async () => {
    const steamId = freshUser();
    steamGames = [{ appid: 620, name: 'Portal 2', playtime_forever: 90 }];
    await syncLibrary(steamId, profileOf(steamId));
    steamGames = [];
    expect((await syncLibrary(steamId, profileOf(steamId)))?.games).toEqual([]);
    expect(await getLibrary(steamId)).toMatchObject({ source: 'index', games: [] });
    expect((await db.collection(paths.userGames(steamId)).get()).empty).toBe(true);
  });

  it('records hidden playtime on the profile without clobbering other flags, and clears it once playtime shows', async () => {
    const steamId = freshUser();
    await db.doc(paths.user(steamId)).set({ ...profileOf(steamId), flags: { friendsListPublic: true } });
    steamGames = Array.from({ length: 6 }, (_, index) => ({ appid: 10 * (index + 1), name: `Game ${index}`, playtime_forever: 0 }));
    expect((await syncLibrary(steamId, profileOf(steamId)))?.playtimeHidden).toBe(true);
    expect((await db.doc(paths.user(steamId)).get()).data()?.flags).toEqual({ friendsListPublic: true, playtimeHidden: true });
    expect((await getLibrary(steamId)).playtimeHidden).toBe(true);

    steamGames[0] = { ...steamGames[0], playtime_forever: 3 };
    expect((await syncLibrary(steamId, profileOf(steamId)))?.playtimeHidden).toBe(false);
    expect((await db.doc(paths.user(steamId)).get()).data()?.flags).toEqual({ friendsListPublic: true, playtimeHidden: false });
  });

  it('writes nothing when Steam does not share the library', async () => {
    const steamId = freshUser();
    steamGames = null;
    expect(await syncLibrary(steamId, profileOf(steamId))).toBeNull();
    expect((await readLibIndex(steamId)).built).toBe(false);
    expect((await db.doc(paths.user(steamId)).get()).exists).toBe(false);
  });

  it('syncs a 3,000-game library across several write batches', async () => {
    const steamId = freshUser();
    steamGames = Array.from({ length: 3000 }, (_, index) => ({
      appid: 10 * (index + 1), name: `Game ${index}`, playtime_forever: index % 7, rtime_last_played: index % 7 ? 1_600_000_000 + index : 0,
    }));
    expect((await syncLibrary(steamId, profileOf(steamId)))?.games).toHaveLength(3000);
    expect((await readLibIndex(steamId)).entries.size).toBe(3000);
    expect((await db.collection(paths.userGames(steamId)).count().get()).data().count).toBe(3000);
    const reads = countReads();
    expect(await getStoredGames(steamId)).toHaveLength(3000);
    expect(reads()).toBe(4);
  }, 120_000);
});
