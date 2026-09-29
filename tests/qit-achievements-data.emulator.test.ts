import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/firestore';
import { getCachedAchievementProgress as legacyEntryPoint } from '../src/lib/achievement-cache';
import {
  ACHIEVEMENT_TTL_MS, PRIVATE_RECHECK_MS, getCachedAchievementProgress, readAchievementRecord, readAchievementRecords, scanAchievements,
} from '../src/lib/achievements';
import { createSteamClient } from '../src/lib/steam/client';
import { patchLibIndex, readLibIndex } from '../src/lib/store/lib-index';
import { paths } from '../src/lib/store/paths';

// Emulator-only (npm run test:firestore). Skipped elsewhere so it can never touch a real project.
const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;

let nextId = 0;
const freshUser = () => `7656119902${String(Date.now() % 1e5).padStart(5, '0')}${String(nextId++ % 100).padStart(2, '0')}`;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-29T12:00:00Z');

type Answer = { status: number; body: unknown };
const ok = (unlocked: number, total: number, unlocktime = 1_700_000_000): Answer => ({ status: 200, body: { playerstats: { success: true,
  achievements: [...Array(total)].map((_, i) => ({ apiname: `ACH_${i}`, achieved: i < unlocked ? 1 : 0, unlocktime: i < unlocked ? unlocktime + i : 0,
    name: `Name ${i}`, description: i === total - 1 ? '' : `Description ${i}` })) } } });
const noStats: Answer = { status: 400, body: { playerstats: { success: false, error: 'Requested app has no stats' } } };
const privateStats: Answer = { status: 403, body: { playerstats: { success: false, error: 'Profile is not public' } } };

/** A fake Steam that answers GetPlayerAchievements per appid and records each call. */
function fakeSteam(answers: Record<number, Answer>, fallback: Answer = ok(1, 2)) {
  const calls: Array<{ appid: number; language: string | null }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (!url.pathname.includes('GetPlayerAchievements')) throw new Error('Unexpected request');
    const appid = Number(url.searchParams.get('appid'));
    calls.push({ appid, language: url.searchParams.get('l') });
    const answer = answers[appid] ?? fallback;
    return Response.json(answer.body, { status: answer.status });
  });
  return { calls, fetchMock, client: createSteamClient({ fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} }) };
}

beforeEach(() => { vi.stubEnv('STEAM_API_KEY', 'emulator-test-key'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe.skipIf(!emulated)('getCachedAchievementProgress (emulator)', () => {
  it('keeps its old signature and entry point, and stores the v2 record plus the index summary', async () => {
    expect(legacyEntryPoint).toBe(getCachedAchievementProgress);
    const steamId = freshUser();
    await patchLibIndex(steamId, { 620: { n: 'Portal 2', p: 90 } }, { create: true });
    const steam = fakeSteam({ 620: ok(3, 4) });
    vi.stubGlobal('fetch', steam.fetchMock);

    expect(await getCachedAchievementProgress(steamId, 620)).toEqual({ unlocked: 3, total: 4, percent: 75 });
    expect(await getCachedAchievementProgress(steamId, 620)).toEqual({ unlocked: 3, total: 4, percent: 75 });
    expect(steam.calls).toEqual([{ appid: 620, language: 'english' }]);

    const raw = (await db.doc(paths.achievementProgressDoc(steamId, 620)).get()).data()!;
    expect(raw.expiresAt).toBeInstanceOf(Timestamp);
    expect(typeof raw.fetchedAt).toBe('string');
    expect(await readAchievementRecord(steamId, 620)).toMatchObject({
      v: 2, state: 'ok', progress: { unlocked: 3, total: 4, percent: 75 }, lastUnlockAt: 1_700_000_002,
      locked: [{ apiname: 'ACH_3', name: 'Name 3' }], lockedTruncated: false,
    });
    expect((await readLibIndex(steamId)).entries.get(620)).toEqual({ n: 'Portal 2', p: 90, ap: 75, au: 3, at: 4 });
  });

  it('refetches a pre-v2 record and marks no-stats games as having zero achievements in the index', async () => {
    const steamId = freshUser();
    await patchLibIndex(steamId, { 7: { n: 'Steam', p: 0, ap: 10, au: 1, at: 10 } }, { create: true });
    await db.doc(paths.achievementProgressDoc(steamId, 7)).set({ progress: { unlocked: 1, total: 10, percent: 10 }, fetchedAt: new Date().toISOString() });
    const steam = fakeSteam({ 7: noStats });
    vi.stubGlobal('fetch', steam.fetchMock);

    expect(await getCachedAchievementProgress(steamId, 7)).toBeNull();
    expect(steam.calls).toHaveLength(1);
    expect((await readLibIndex(steamId)).entries.get(7)).toEqual({ n: 'Steam', p: 0, at: 0 });
    const record = await readAchievementRecord(steamId, 7);
    expect(record?.state).toBe('no_stats');
    expect(record!.expiresAtMs - Date.parse(record!.fetchedAt)).toBe(ACHIEVEMENT_TTL_MS.noStats);
  });

  it('records private achievements once per user, asks Steam again after the recheck time, and does not create index entries', async () => {
    const steamId = freshUser();
    await patchLibIndex(steamId, { 620: { n: 'Portal 2', ap: 50, au: 1, at: 2 } }, { create: true });
    const steam = fakeSteam({ 620: privateStats, 730: ok(1, 1) });
    vi.stubGlobal('fetch', steam.fetchMock);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);

    expect(await getCachedAchievementProgress(steamId, 620)).toBeNull();
    expect(await getCachedAchievementProgress(steamId, 730)).toBeNull();
    expect(steam.calls.map(call => call.appid)).toEqual([620]);
    expect(await readAchievementRecord(steamId, 620)).toBeNull();
    expect((await readLibIndex(steamId)).entries.get(620)).toEqual({ n: 'Portal 2', ap: 50, au: 1, at: 2 });

    vi.setSystemTime(NOW + PRIVATE_RECHECK_MS + 1);
    expect(await getCachedAchievementProgress(steamId, 730)).toEqual({ unlocked: 1, total: 1, percent: 100 });
    expect(steam.calls.map(call => call.appid)).toEqual([620, 730]);
    expect((await readLibIndex(steamId)).entries.has(730)).toBe(false);
    const complete = await readAchievementRecord(steamId, 730);
    expect(complete!.expiresAtMs - Date.parse(complete!.fetchedAt)).toBe(ACHIEVEMENT_TTL_MS.complete);
  });
});

describe.skipIf(!emulated)('scanAchievements (emulator)', () => {
  it('scans an indexed library in priority order, stores every answer, and only refreshes what expired', async () => {
    const steamId = freshUser();
    // 20 games, plus 999 which the store metadata (`f` known, no achievements category) rules out.
    const games = Object.fromEntries([...Array(20)].map((_, i) => [(i + 1) * 10, { n: `Game ${i}`, p: (i + 1) * 60 }]));
    await patchLibIndex(steamId, { ...games, 999: { n: 'Soundtrack', p: 5000, f: 1 } }, { create: true });
    const steam = fakeSteam({ 200: ok(2, 2), 180: noStats });
    let clock = NOW;
    const run = (cursor: string | null) => scanAchievements(steamId, { cursor, client: steam.client, now: () => clock });

    const first = await run(null);
    expect(first).toMatchObject({ state: 'running', progress: { done: 15, total: 20 }, fetched: { ok: 14, noStats: 1, failed: 0 } });
    // Every other hint is unknown, so the order is by playtime.
    expect(steam.calls.slice(0, 3).map(call => call.appid)).toEqual([200, 190, 180]);
    expect(steam.calls.every(call => call.language === 'english')).toBe(true);
    expect(steam.calls.map(call => call.appid)).not.toContain(999);
    const second = await run(first.cursor);
    expect(second).toMatchObject({ state: 'complete', cursor: null, progress: { done: 20, total: 20 }, fetched: { ok: 5 } });
    expect(steam.calls).toHaveLength(20);

    const records = await readAchievementRecords(steamId, [200, 180, 10, 999]);
    expect(records.get(200)).toMatchObject({ state: 'ok', progress: { percent: 100 } });
    expect(records.get(180)?.state).toBe('no_stats');
    expect(records.get(10)?.state).toBe('ok');
    expect(records.get(999)).toBeNull();
    const { entries } = await readLibIndex(steamId);
    expect(entries.get(200)).toMatchObject({ ap: 100, au: 2, at: 2 });
    expect(entries.get(180)).toMatchObject({ at: 0 });
    expect(entries.get(999)).toEqual({ n: 'Soundtrack', p: 5000, f: 1 });

    // A day later only the in-progress games (24 h) are due; complete (30 d) and no-stats (7 d) games are not.
    clock = NOW + DAY + 1;
    const again = await run(null);
    expect(again).toMatchObject({ state: 'running', fetched: { ok: 15 } });
    expect((await run(again.cursor))).toMatchObject({ state: 'complete', fetched: { ok: 3 } });
    expect(steam.calls.slice(20).map(call => call.appid)).not.toContain(200);
    expect(steam.calls.slice(20).map(call => call.appid)).not.toContain(180);
    expect(steam.calls).toHaveLength(38);
  });

  it('stops at once on private achievements and calls Steam for no game until the recheck time', async () => {
    const steamId = freshUser();
    await patchLibIndex(steamId, { 100: { n: 'A', p: 10 }, 200: { n: 'B', p: 500 }, 300: { n: 'C', p: 50 } }, { create: true });
    const steam = fakeSteam({}, privateStats);
    const run = (now: number) => scanAchievements(steamId, { client: steam.client, now: () => now });
    const stopped = { state: 'private', cursor: null, progress: { done: 0, total: 3 } };

    expect(await run(NOW)).toEqual({ ...stopped, fetched: { ok: 0, noStats: 0, private: 1, failed: 0 } });
    expect(await run(NOW + 1000)).toEqual({ ...stopped, fetched: { ok: 0, noStats: 0, private: 0, failed: 0 } });
    expect(steam.calls.map(call => call.appid)).toEqual([200]);
    expect([...(await readAchievementRecords(steamId, [100, 200, 300])).values()]).toEqual([null, null, null]);

    const publicSteam = fakeSteam({});
    expect(await scanAchievements(steamId, { client: publicSteam.client, now: () => NOW + PRIVATE_RECHECK_MS + 1 }))
      .toMatchObject({ state: 'complete', fetched: { ok: 3, private: 0 } });
  });

  it('fills in the index summary of records stored before the index was built, without calling Steam', async () => {
    const steamId = freshUser();
    const steam = fakeSteam({ 620: ok(1, 4) });
    vi.stubGlobal('fetch', steam.fetchMock);
    expect(await getCachedAchievementProgress(steamId, 620)).toEqual({ unlocked: 1, total: 4, percent: 25 });
    await patchLibIndex(steamId, { 620: { n: 'Portal 2', p: 90 } }, { create: true });
    expect(await scanAchievements(steamId, { client: steam.client })).toMatchObject({ state: 'complete', fetched: { ok: 0 } });
    expect(steam.calls).toHaveLength(1);
    expect((await readLibIndex(steamId)).entries.get(620)).toEqual({ n: 'Portal 2', p: 90, ap: 25, au: 1, at: 4 });
  });

  it('asks for a library sync before the index is built', async () => {
    const steam = fakeSteam({});
    expect(await scanAchievements(freshUser(), { client: steam.client, now: () => NOW })).toEqual({
      state: 'needs_sync', cursor: null, progress: { done: 0, total: 0 }, fetched: { ok: 0, noStats: 0, private: 0, failed: 0 },
    });
    expect(steam.calls).toHaveLength(0);
  });
});
