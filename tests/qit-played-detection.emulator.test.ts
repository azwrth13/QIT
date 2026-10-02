import { Query } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/firestore';
import { detectPlayedRolls } from '../src/lib/history/played';
import * as played from '../src/lib/history/played';
import {
  buildRollRecord, getRoll, markPlayed, markRerolled, recentRolls, recordRoll,
  PLAYED_DETECTION_ROLL_LIMIT, PLAYED_DETECTION_WINDOW_DAYS, type RollInput,
} from '../src/lib/history/rolls';
import { readStats } from '../src/lib/history/stats';
import { getLibrary, syncLibrary } from '../src/lib/library';
import type { SteamProfile } from '../src/lib/steam';
import { paths } from '../src/lib/store/paths';

const { getSteamId, getSteamProfile } = vi.hoisted(() => ({ getSteamId: vi.fn(), getSteamProfile: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getSteamId }));
vi.mock('../src/lib/steam', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/steam')>(), getSteamProfile,
}));
import { POST as syncRoute } from '../src/app/api/games/sync/route';

const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;
let nextId = 0;
const freshUser = () => `7656119906${String(Date.now() % 1e5).padStart(5, '0')}${String(nextId++ % 100).padStart(2, '0')}`;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-28T10:00:00Z');
/** Sync paths bound the window by the real clock, so their fixtures must be recent relative to it. */
const recently = () => Date.now() - 60_000;
const input = (overrides: Partial<RollInput> = {}): RollInput => ({
  appid: 620, modeId: 'pure-random', filters: [], scope: { kind: 'library' },
  playtimeAtRoll: 100, reasons: [], ...overrides,
});
const profileOf = (steamId: string): SteamProfile => ({
  steamId, personaName: 'Played tester', profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
  avatarFull: 'https://example.test/full.jpg', avatarMedium: 'https://example.test/medium.jpg', public: true,
});
let steamGames: Array<{ appid: number; name: string; playtime_forever: number; rtime_last_played?: number }> | null;
const playedEvents = async (steamId: string) =>
  (await db.collection(paths.events(steamId)).where('type', '==', 'played').get()).docs.map(doc => doc.data());

beforeEach(() => {
  vi.stubEnv('STEAM_API_KEY', 'emulator-test-key');
  steamGames = [{ appid: 620, name: 'Portal 2', playtime_forever: 110 }];
  getSteamId.mockReset();
  getSteamProfile.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
    if (!String(url).includes('GetOwnedGames')) throw new Error('Unexpected Steam request');
    return Response.json({ response: steamGames === null ? {} : { game_count: steamGames.length, games: steamGames } });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe.skipIf(!emulated)('played detection (emulator)', () => {
  it('syncs first, marks at 10 minutes but not 9, and a re-sync never double-counts', async () => {
    const steamId = freshUser();
    const at = recently();
    const nine = await recordRoll(steamId, input({ appid: 730, playtimeAtRoll: 101 }), at);
    const ten = await recordRoll(steamId, input(), at);
    steamGames!.push({ appid: 730, name: 'CS2', playtime_forever: 110 });
    // Played is independent of the user's card decision.
    await markRerolled(steamId, ten, at + 1);
    const result = await syncLibrary(steamId, profileOf(steamId));
    expect((await getLibrary(steamId)).games).toEqual(result?.games);
    expect(await getRoll(steamId, nine)).toMatchObject({ playedAt: null, playedSource: null });
    expect(await getRoll(steamId, ten)).toMatchObject({ status: 'rerolled', playedSource: 'sync' });
    const firstMark = (await getRoll(steamId, ten))!.playedAt;
    expect(firstMark?.toISOString()).toBe(result?.lastSynced);
    await syncLibrary(steamId, profileOf(steamId));
    expect((await getRoll(steamId, ten))!.playedAt).toEqual(firstMark);
    expect(await playedEvents(steamId)).toMatchObject([{ refId: ten, appid: 620, meta: { source: 'sync' } }]);
    expect((await readStats(steamId)).counters).toMatchObject({ played: 1, 'played:source:sync': 1 });
  });

  it('preserves a manual mark and its event source when a later sync qualifies', async () => {
    const steamId = freshUser();
    const at = recently();
    const rollId = await recordRoll(steamId, input(), at);
    await markPlayed(steamId, rollId, 'manual', at + 1);
    await syncLibrary(steamId, profileOf(steamId));
    expect(await getRoll(steamId, rollId)).toMatchObject({ playedAt: new Date(at + 1), playedSource: 'manual' });
    expect(await playedEvents(steamId)).toMatchObject([{ refId: rollId, meta: { source: 'manual' } }]);
    expect((await readStats(steamId)).counters.played).toBe(1);
    expect((await readStats(steamId)).counters['played:source:sync']).toBeUndefined();
  });

  it('hidden playtime provides no signal and does not erase the baseline; a later visible sync qualifies', async () => {
    const steamId = freshUser();
    const rollId = await recordRoll(steamId, input(), recently());
    steamGames = Array.from({ length: 5 }, (_, i) => ({ appid: i ? i * 10 : 620, name: 'Game', playtime_forever: 0 }));
    expect((await syncLibrary(steamId, profileOf(steamId)))?.playtimeHidden).toBe(true);
    expect(await getRoll(steamId, rollId)).toMatchObject({ playedAt: null, playedSource: null, playtimeAtRoll: 100 });
    expect(await playedEvents(steamId)).toEqual([]);
    // The explicit hidden flag also suppresses detection if totals happen to be present.
    expect(await detectPlayedRolls(steamId, {
      games: [{ appid: 620, name: 'Game', img_icon_url: '', playtime_forever: 110 }], playtimeHidden: true,
    })).toBe(0);
    steamGames[0].playtime_forever = 110;
    await syncLibrary(steamId, profileOf(steamId));
    expect((await getRoll(steamId, rollId))!.playedSource).toBe('sync');
  });

  it('leaves unknown baselines, missing games and reduced totals pending', async () => {
    const steamId = freshUser();
    const ids = await Promise.all([
      recordRoll(steamId, input({ playtimeAtRoll: null }), recently()),
      recordRoll(steamId, input({ appid: 400, playtimeAtRoll: 0 }), recently()),
      recordRoll(steamId, input({ appid: 730, playtimeAtRoll: 200 }), recently()),
    ]);
    steamGames!.push({ appid: 730, name: 'CS2', playtime_forever: 110 });
    await syncLibrary(steamId, profileOf(steamId));
    for (const id of ids) expect((await getRoll(steamId, id))!.playedAt).toBeNull();
    expect(await playedEvents(steamId)).toEqual([]);
  });

  it('ignores growth Steam last played before the roll, from a stale index baseline', async () => {
    const steamId = freshUser();
    const at = recently();
    // The index still showed 100 when the game was rolled; the 60 minutes were played before the roll.
    const rollId = await recordRoll(steamId, input(), at);
    steamGames = [{ appid: 620, name: 'Portal 2', playtime_forever: 160, rtime_last_played: Math.floor(at / 1000) - 600 }];
    await syncLibrary(steamId, profileOf(steamId));
    expect((await getRoll(steamId, rollId))!.playedAt).toBeNull();
    expect(await playedEvents(steamId)).toEqual([]);
    steamGames[0] = { ...steamGames[0], playtime_forever: 170, rtime_last_played: Math.floor(at / 1000) + 60 };
    await syncLibrary(steamId, profileOf(steamId));
    expect((await getRoll(steamId, rollId))!.playedSource).toBe('sync');
  });

  it('counts one play session once across several rolls of the same game, even on re-sync', async () => {
    const steamId = freshUser();
    const at = recently();
    const older = await recordRoll(steamId, input(), at - 2000);
    const middle = await recordRoll(steamId, input(), at - 1000);
    const newest = await recordRoll(steamId, input(), at);
    await syncLibrary(steamId, profileOf(steamId));
    await syncLibrary(steamId, profileOf(steamId));
    expect(await getRoll(steamId, newest)).toMatchObject({ playedSource: 'sync' });
    expect(await getRoll(steamId, middle)).toMatchObject({ playedAt: null });
    expect(await getRoll(steamId, older)).toMatchObject({ playedAt: null });
    expect(await playedEvents(steamId)).toMatchObject([{ refId: newest }]);
    expect((await readStats(steamId)).counters).toMatchObject({ played: 1, 'played:source:sync': 1 });
  });

  it('keeps concurrent detections idempotent through the single writer', async () => {
    const steamId = freshUser();
    await recordRoll(steamId, input(), NOW);
    const library = { games: [{ appid: 620, name: 'Game', img_icon_url: '', playtime_forever: 110 }], playtimeHidden: false };
    const counts = await Promise.all([detectPlayedRolls(steamId, library, NOW + 1), detectPlayedRolls(steamId, library, NOW + 1)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await playedEvents(steamId)).toHaveLength(1);
    expect((await readStats(steamId)).counters.played).toBe(1);
  });

  it('bounds history reads and excludes old, future and already marked rolls', async () => {
    const steamId = freshUser();
    const old = await recordRoll(steamId, input(), NOW - (PLAYED_DETECTION_WINDOW_DAYS + 1) * DAY);
    const future = await recordRoll(steamId, input(), NOW + 1);
    const edge = await recordRoll(steamId, input(), NOW - PLAYED_DETECTION_WINDOW_DAYS * DAY);
    const manual = await recordRoll(steamId, input(), NOW);
    await markPlayed(steamId, manual, 'manual', NOW);
    expect((await recentRolls(steamId, NOW)).map(roll => roll.id)).toEqual([manual, edge]);

    // Fixture history fills the recent cap; no production code writes rolls outside the single writer.
    const batch = db.batch();
    for (let i = 0; i < PLAYED_DETECTION_ROLL_LIMIT + 5; i++) {
      batch.set(db.doc(paths.roll(steamId, `recent-${i}`)), buildRollRecord(steamId, input({ playtimeAtRoll: null }), NOW - i));
    }
    await batch.commit();
    const queryGet = Query.prototype.get;
    const sizes: number[] = [];
    vi.spyOn(Query.prototype, 'get').mockImplementation(async function (this: Query) {
      const snapshot = await queryGet.call(this);
      sizes.push(snapshot.size);
      return snapshot;
    });
    const recent = await recentRolls(steamId, NOW);
    expect(sizes).toEqual([PLAYED_DETECTION_ROLL_LIMIT]);
    expect(recent.some(roll => [old, future, edge].includes(roll.id))).toBe(false);
  });

  it('the sync route succeeds and persists its library even when detection fails; the next sync retries', async () => {
    const steamId = freshUser();
    const rollId = await recordRoll(steamId, input(), recently());
    getSteamId.mockResolvedValue(steamId);
    getSteamProfile.mockResolvedValue(profileOf(steamId));
    const realDetect = played.detectPlayedRolls;
    const detector = vi.spyOn(played, 'detectPlayedRolls').mockImplementationOnce(async (...args) => {
      // The hook is after the index/profile writes, observable even when detection throws.
      expect((await getLibrary(steamId)).games[0].playtime_forever).toBe(110);
      expect((await getLibrary(steamId)).lastSyncedAt).not.toBeNull();
      expect(args[0]).toBe(steamId);
      throw new Error('Detection unavailable');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await syncRoute();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ playtimeHidden: false, games: [{ appid: 620, playtime_forever: 110 }] });
    expect(logged).toHaveBeenCalledWith('Played detection failed', { name: 'Error' });
    expect((await getRoll(steamId, rollId))!.playedAt).toBeNull();
    detector.mockImplementation(realDetect);
    expect((await syncRoute()).status).toBe(200);
    expect((await getRoll(steamId, rollId))!.playedSource).toBe('sync');
    expect(await playedEvents(steamId)).toHaveLength(1);
  });

  it('does not detect for a private library', async () => {
    const steamId = freshUser();
    await recordRoll(steamId, input(), recently());
    steamGames = null;
    const detector = vi.spyOn(played, 'detectPlayedRolls');
    expect(await syncLibrary(steamId, profileOf(steamId))).toBeNull();
    expect(detector).not.toHaveBeenCalled();
    expect(await playedEvents(steamId)).toEqual([]);
  });
});
