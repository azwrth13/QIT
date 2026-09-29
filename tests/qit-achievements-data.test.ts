import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACHIEVEMENT_TTL_MS, MAX_LOCKED_STORED, achievementSignalsFromIndex, achievementSupportHint, buildAchievementRecord,
  decodeScanCursor, encodeScanCursor, indexMatches, indexPatchFor, isFresh, planScan, positionAfter, scanKeyOf, toAchievementSignals,
  type AchievementRecord,
} from '../src/lib/achievements/model';
import { fromStored } from '../src/lib/achievements/store';
import { SteamClientError } from '../src/lib/steam/client';
import type { PlayerAchievement } from '../src/lib/steam/achievements';

const { getSteamId, readLibIndex, readAchievementRecords, fetchAchievementRecord, saveAchievementRecords } = vi.hoisted(() => ({
  getSteamId: vi.fn(), readLibIndex: vi.fn(), readAchievementRecords: vi.fn(), fetchAchievementRecord: vi.fn(), saveAchievementRecords: vi.fn(),
}));
vi.mock('../src/lib/auth', () => ({ getSteamId }));
vi.mock('../src/lib/store/lib-index', () => ({ readLibIndex }));
vi.mock('../src/lib/achievements/store', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/achievements/store')>(), readAchievementRecords, fetchAchievementRecord, saveAchievementRecords,
}));

import { scanAchievements, SCAN_BATCH_SIZE, SCAN_EXAMINE_LIMIT } from '../src/lib/achievements/scan';
import { POST } from '../src/app/api/achievements/scan/route';

const steamId = '76561198000000042';
const NOW = Date.parse('2026-09-29T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const achievement = (apiname: string, unlocktime: number | null, extra: Partial<PlayerAchievement> = {}): PlayerAchievement =>
  ({ apiname, achieved: unlocktime !== null, unlocktime, ...extra });

describe('achievement records', () => {
  it('stores progress, locked achievements with English text, and the newest unlock', () => {
    const record = buildAchievementRecord({ state: 'ok', achievements: [
      achievement('A', 1_700_000_000, { name: 'First', description: 'Do it' }),
      achievement('B', null, { name: 'Second', description: 'Do more' }),
      achievement('C', 1_700_000_500),
      achievement('D', null, { name: 'Hidden', description: '' }),
    ] }, NOW);
    expect(record).toEqual({
      v: 2, state: 'ok', progress: { unlocked: 2, total: 4, percent: 50 },
      locked: [{ apiname: 'B', name: 'Second', description: 'Do more' }, { apiname: 'D', name: 'Hidden' }],
      lockedTruncated: false, lastUnlockAt: 1_700_000_500, fetchedAt: '2026-09-29T12:00:00.000Z', expiresAtMs: NOW + DAY,
    });
  });
  it('floors the percent, so only a fully unlocked game is 100% and gets the long TTL', () => {
    const almost = buildAchievementRecord({ state: 'ok', achievements: [...Array(199)].map((_, i) => achievement(`A${i}`, 1)).concat(achievement('Z', null)) }, NOW);
    expect(almost.progress).toEqual({ unlocked: 199, total: 200, percent: 99 });
    expect(almost.expiresAtMs).toBe(NOW + ACHIEVEMENT_TTL_MS.inProgress);
    const done = buildAchievementRecord({ state: 'ok', achievements: [achievement('A', 5), achievement('B', 6)] }, NOW);
    expect(done.progress?.percent).toBe(100);
    expect(done.expiresAtMs).toBe(NOW + 30 * DAY);
    expect(done.locked).toEqual([]);
  });
  it('caches no stats for a week and private achievements only briefly', () => {
    expect(buildAchievementRecord({ state: 'no_stats' }, NOW)).toMatchObject({ state: 'no_stats', progress: null, locked: [], expiresAtMs: NOW + 7 * DAY });
    expect(buildAchievementRecord({ state: 'private' }, NOW)).toMatchObject({ state: 'private', progress: null, expiresAtMs: NOW + HOUR });
  });
  it('caps the locked list and its text', () => {
    const many = [...Array(MAX_LOCKED_STORED + 5)].map((_, i) => achievement(`L${i}`, null, { name: 'n'.repeat(500), description: 'd'.repeat(500) }));
    const record = buildAchievementRecord({ state: 'ok', achievements: many }, NOW);
    expect(record.locked).toHaveLength(MAX_LOCKED_STORED);
    expect(record.lockedTruncated).toBe(true);
    expect(record.progress).toEqual({ unlocked: 0, total: MAX_LOCKED_STORED + 5, percent: 0 });
    expect(record.lastUnlockAt).toBeNull();
    expect(record.locked[0].name).toHaveLength(128);
    expect(record.locked[0].description).toHaveLength(256);
  });
  it('knows when a record is fresh', () => {
    expect(isFresh(null, NOW)).toBe(false);
    expect(isFresh({ expiresAtMs: NOW + 1 }, NOW)).toBe(true);
    expect(isFresh({ expiresAtMs: NOW }, NOW)).toBe(false);
  });
  it('maps records to index summaries and roulette signals, keeping unknown apart from zero', () => {
    const ok = buildAchievementRecord({ state: 'ok', achievements: [achievement('A', 10), achievement('B', null)] }, NOW);
    expect(indexPatchFor(ok)).toEqual({ ap: 50, au: 1, at: 2 });
    expect(indexPatchFor({ state: 'no_stats', progress: null })).toEqual({ ap: null, au: null, at: 0 });
    expect(indexPatchFor({ state: 'private', progress: null })).toEqual({ ap: null, au: null, at: null });
    expect(toAchievementSignals(ok)).toEqual({ total: 2, unlocked: 1, percent: 50, lockedRare: null, lastUnlockAt: 10 });
    expect(toAchievementSignals(buildAchievementRecord({ state: 'no_stats' }, NOW))).toBeNull();
    expect(toAchievementSignals(null)).toBeNull();
    expect(indexMatches({ ap: 50, au: 1, at: 2, p: 5 } as object, ok)).toBe(true);
    expect(indexMatches({ ap: 50, au: 1 }, ok)).toBe(false);
    expect(indexMatches({ at: 0 }, { state: 'no_stats', progress: null })).toBe(true);
    expect(indexMatches({}, { state: 'private', progress: null })).toBe(true);
    expect(indexMatches({ at: 0 }, { state: 'private', progress: null })).toBe(false);
    expect(achievementSignalsFromIndex({ ap: 50, au: 1, at: 2 })).toEqual({ total: 2, unlocked: 1, percent: 50, lockedRare: null, lastUnlockAt: null });
    expect(achievementSignalsFromIndex({ at: 0 })).toBeNull();
    expect(achievementSignalsFromIndex({})).toBeNull();
  });
});

describe('stored records', () => {
  const stored = (overrides: Record<string, unknown> = {}) => ({
    v: 2, state: 'ok', progress: { unlocked: 1, total: 2, percent: 50 }, locked: [{ apiname: 'B', name: 'x' }, { bad: 1 }],
    lockedTruncated: false, lastUnlockAt: 10, fetchedAt: 'iso', expiresAt: Timestamp.fromMillis(NOW), ...overrides,
  });
  it('reads what this package wrote', () => {
    expect(fromStored(stored())).toEqual({
      v: 2, state: 'ok', progress: { unlocked: 1, total: 2, percent: 50 }, locked: [{ apiname: 'B', name: 'x' }],
      lockedTruncated: false, lastUnlockAt: 10, fetchedAt: 'iso', expiresAtMs: NOW,
    });
    expect(fromStored(stored({ state: 'no_stats', progress: null, locked: [] }))).toMatchObject({ state: 'no_stats', progress: null });
  });
  it('treats pre-v2 and malformed documents as missing, so they are refetched', () => {
    expect(fromStored(undefined)).toBeNull();
    expect(fromStored({ progress: { unlocked: 1, total: 2, percent: 50 }, fetchedAt: new Date(NOW).toISOString() })).toBeNull();
    expect(fromStored(stored({ state: 'weird' }))).toBeNull();
    expect(fromStored(stored({ expiresAt: NOW }))).toBeNull();
    expect(fromStored(stored({ progress: null }))).toBeNull();
    expect(fromStored(stored({ progress: { unlocked: 3, total: 2, percent: 150 } }))).toBeNull();
  });
});

describe('scan order and cursor', () => {
  it('uses the store category when known, else the community-stats flag', () => {
    expect(achievementSupportHint({ f: 1 | 1 << 6 })).toBe(true);
    expect(achievementSupportHint({ f: 1, s: 1 })).toBe(false);
    expect(achievementSupportHint({ f: 0, s: 1 })).toBe(true);
    expect(achievementSupportHint({ s: 0 })).toBe(false);
    expect(achievementSupportHint({})).toBeNull();
  });
  it('puts known achievement games first, then the most played, and drops games ruled out', () => {
    const order = planScan([
      [10, { p: 5 }], [20, { p: 500, s: 0 }], [30, { p: 50, s: 1 }], [40, { p: 900 }], [50, { p: 50, s: 1 }], [60, {}],
    ]);
    expect(order.map(candidate => candidate.appid)).toEqual([30, 50, 40, 10, 60]);
    expect(order[0]).toEqual({ appid: 30, playtime: 50, tier: 0 });
  });
  it('round-trips the cursor and resumes after it even when the library changed', () => {
    const order = planScan([[10, { p: 5 }], [30, { p: 50, s: 1 }], [40, { p: 900 }]]);
    const cursor = encodeScanCursor(order[1]);
    expect(decodeScanCursor(cursor)).toEqual(scanKeyOf(order[1]));
    expect(positionAfter(order, decodeScanCursor(cursor))).toBe(2);
    expect(positionAfter(order, null)).toBe(0);
    // Game 40 left the library and 35 arrived between two batches: the scan still resumes right after the cursor key.
    const changed = planScan([[10, { p: 5 }], [30, { p: 50, s: 1 }], [35, { p: 1000 }]]);
    expect(changed[positionAfter(changed, decodeScanCursor(cursor))].appid).toBe(10);
  });
  it('rejects malformed cursors', () => {
    const encode = (value: unknown) => `a1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    for (const cursor of ['', 'x', 'a1.!!', encode([0, 1]), encode([2, 1, 10]), encode([0, -1, 10]), encode([0, 1, 0]), encode([0, 1.5, 10]),
      encode({ a: 1 }), `a1.${'A'.repeat(200)}`]) {
      expect(decodeScanCursor(cursor)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

const okRecord = (unlocked = 1, total = 2): AchievementRecord => ({
  v: 2, state: 'ok', progress: { unlocked, total, percent: Math.floor(unlocked / total * 100) }, locked: [], lockedTruncated: false,
  lastUnlockAt: null, fetchedAt: '', expiresAtMs: NOW + DAY,
});
const negative = (state: 'no_stats' | 'private'): AchievementRecord => ({ ...okRecord(), state, progress: null });

/** A library of `count` games with descending playtime, so scan order is appid order. */
function library(count: number, extra: Record<number, object> = {}) {
  const entries = new Map([...Array(count)].map((_, i) => [(i + 1) * 10, { n: `G${i}`, p: 10_000 - i, s: 1, ...extra[(i + 1) * 10] }]));
  readLibIndex.mockResolvedValue({ entries, built: true, updatedAt: null });
}

let fresh: Set<number>;
let answers: Map<number, AchievementRecord | Error>;

beforeEach(() => {
  vi.resetAllMocks();
  fresh = new Set();
  answers = new Map();
  readAchievementRecords.mockImplementation(async (_id: string, appids: number[]) =>
    new Map(appids.map(appid => [appid, fresh.has(appid) ? okRecord() : null])));
  fetchAchievementRecord.mockImplementation(async (_id: string, appid: number) => {
    const answer = answers.get(appid) ?? okRecord();
    if (answer instanceof Error) throw answer;
    return answer;
  });
  saveAchievementRecords.mockResolvedValue(undefined);
});

const scan = (cursor?: string | null, extra: Parameters<typeof scanAchievements>[1] = {}) =>
  scanAchievements(steamId, { cursor, now: () => NOW, ...extra });
const fetchedIds = () => fetchAchievementRecord.mock.calls.map(call => call[1]);

describe('scanAchievements', () => {
  it('fetches due games in batches of 15 and walks the whole library with the cursor', async () => {
    library(40);
    fresh = new Set([20, 30]);
    const first = await scan();
    expect(first).toMatchObject({ state: 'running', progress: { done: 17, total: 40 }, fetched: { ok: 15, noStats: 0, private: 0, failed: 0 } });
    expect(fetchedIds()).toEqual([10, ...[...Array(14)].map((_, i) => (i + 4) * 10)]);
    const saved = saveAchievementRecords.mock.calls[0][1] as Map<number, AchievementRecord>;
    expect([...saved.keys()].sort((a, b) => a - b)).toEqual(fetchedIds().sort((a, b) => a - b));
    const second = await scan(first.cursor);
    expect(second).toMatchObject({ state: 'running', progress: { done: 32, total: 40 } });
    const third = await scan(second.cursor);
    expect(third).toMatchObject({ state: 'complete', cursor: null, progress: { done: 40, total: 40 }, fetched: { ok: 8 } });
    expect(new Set(fetchedIds()).size).toBe(38);
    expect(fetchAchievementRecord).toHaveBeenCalledTimes(38);
  });
  it('spends no Steam calls on a fresh library and bounds the reads per call', async () => {
    library(300);
    fresh = new Set([...Array(300)].map((_, i) => (i + 1) * 10));
    const first = await scan();
    expect(first).toMatchObject({ state: 'running', progress: { done: SCAN_EXAMINE_LIMIT, total: 300 } });
    const read = readAchievementRecords.mock.calls.flatMap(call => call[1] as number[]);
    expect(read).toHaveLength(SCAN_EXAMINE_LIMIT);
    await scan(first.cursor);
    expect(await scan((await scan(first.cursor)).cursor)).toMatchObject({ state: 'complete' });
    expect(fetchAchievementRecord).not.toHaveBeenCalled();
  });
  it('honors a smaller limit', async () => {
    library(20);
    expect(await scan(null, { limit: 3 })).toMatchObject({ progress: { done: 3 } });
    expect(fetchAchievementRecord).toHaveBeenCalledTimes(3);
  });
  it('stops after one probe when achievements are private', async () => {
    library(20);
    answers.set(10, negative('private'));
    expect(await scan()).toEqual({ state: 'private', cursor: null, progress: { done: 1, total: 20 }, fetched: { ok: 0, noStats: 0, private: 1, failed: 0 } });
    expect(fetchAchievementRecord).toHaveBeenCalledTimes(1);
    expect([...(saveAchievementRecords.mock.calls[0][1] as Map<number, AchievementRecord>).keys()]).toEqual([10]);
  });
  it('re-syncs the index summary of fresh records only when it differs', async () => {
    library(3, { 20: { ap: 50, au: 1, at: 2 } });
    fresh = new Set([10, 20]);
    await scan();
    const [, fetchedRecords, resync] = saveAchievementRecords.mock.calls[0] as [string, Map<number, AchievementRecord>, Map<number, AchievementRecord>];
    expect([...fetchedRecords.keys()]).toEqual([30]);
    expect([...resync.keys()]).toEqual([10]);
  });
  it('stores no-stats answers and moves on', async () => {
    library(3);
    answers.set(20, negative('no_stats'));
    expect(await scan()).toMatchObject({ state: 'complete', fetched: { ok: 2, noStats: 1 } });
  });
  it('pauses on throttling with a resumable cursor and a retry time', async () => {
    library(20);
    answers.set(10, new SteamClientError('rate_limited', 429, 12));
    expect(await scan()).toMatchObject({ state: 'rate_limited', cursor: null, progress: { done: 0 }, retryAfter: 12 });
    expect(fetchAchievementRecord).toHaveBeenCalledTimes(1);
    answers.clear();
    answers.set(50, new SteamClientError('budget_exhausted'));
    const paused = await scan();
    expect(paused).toMatchObject({ state: 'rate_limited', retryAfter: 3600 });
    // Games settled before the first unsettled one are behind the cursor; nothing is skipped.
    expect(paused.progress.done).toBeLessThanOrEqual(4);
    expect(positionOf(paused.cursor)).toBe(paused.progress.done);
  });
  it('counts other failures, does not cache them, and moves past them', async () => {
    library(3);
    answers.set(20, new SteamClientError('unavailable', 500));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await scan()).toMatchObject({ state: 'complete', fetched: { ok: 2, failed: 1 } });
    expect(log).toHaveBeenCalledWith('Achievement scan fetch failed', { name: 'Error' });
    expect([...(saveAchievementRecords.mock.calls[0][1] as Map<number, AchievementRecord>).keys()]).not.toContain(20);
    log.mockRestore();
  });
  it('starts no new calls after the time budget but always makes progress', async () => {
    library(20);
    let clock = NOW;
    fetchAchievementRecord.mockImplementation(async () => { clock += 10_000; return okRecord(); });
    const result = await scan(null, { now: () => clock, timeBudgetMs: 15_000, concurrency: 1 });
    expect(result.state).toBe('running');
    expect(fetchAchievementRecord).toHaveBeenCalledTimes(2);
    expect(result.progress.done).toBe(2);
  });
  it('rejects a malformed cursor before reading anything', async () => {
    await expect(scan('nope')).rejects.toThrow('Invalid scan cursor');
    expect(readLibIndex).not.toHaveBeenCalled();
  });
});

function positionOf(cursor: string | null): number {
  const order = planScan([...Array(20)].map((_, i) => [(i + 1) * 10, { p: 10_000 - i, s: 1 }] as [number, { p: number; s: number }]));
  return positionAfter(order, cursor ? decodeScanCursor(cursor) : null);
}

describe('POST /api/achievements/scan', () => {
  const post = (body: unknown, headers: Record<string, string> = { origin: 'https://qit.example' }) =>
    POST(new Request('https://qit.example/api/achievements/scan', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));

  beforeEach(() => { getSteamId.mockResolvedValue(steamId); library(2); });

  it('requires a session and a same-origin request', async () => {
    getSteamId.mockResolvedValueOnce(null);
    expect((await post({})).status).toBe(401);
    expect((await post({}, { origin: 'https://evil.example' })).status).toBe(403);
    expect(readLibIndex).not.toHaveBeenCalled();
  });
  it('validates the body', async () => {
    for (const body of ['nope', [], { cursor: 5 }, { limit: 0 }, { limit: SCAN_BATCH_SIZE + 1 }, { limit: 1.5 }, { cursor: 'bad' }]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('invalid');
    }
  });
  it('runs one batch and returns the scan state without caching', async () => {
    const response = await post({ cursor: null, limit: 5 });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      state: 'complete', cursor: null, progress: { done: 2, total: 2 }, fetched: { ok: 2, noStats: 0, private: 0, failed: 0 }, message: null,
    });
  });
  it('explains a private profile', async () => {
    answers.set(10, negative('private'));
    const body = await (await post({})).json();
    expect(body.state).toBe('private');
    expect(body.message).toContain('Game details to Public');
  });
  it('returns the error envelope when storage fails', async () => {
    readLibIndex.mockRejectedValueOnce(new Error('down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await post({});
    expect(response.status).toBe(502);
    expect(log).toHaveBeenCalledWith('Achievement scan failed', { name: 'Error' });
    log.mockRestore();
  });
});
