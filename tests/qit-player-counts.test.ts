import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { activityBand, APP_LIVE_TTL_MS, getCurrentPlayers, getTopConcurrentApps, liveSignalsOf, prefilterByConcurrency } from '../src/lib/apps/live-players';
import { createSteamClient } from '../src/lib/steam/client';
import { THRESHOLDS } from '../src/lib/roulette/thresholds';
import type { AppLiveRecord } from '../src/lib/store/types';

const { readAppLive, writeAppLive, readConcurrentChart, writeConcurrentChart } = vi.hoisted(() => ({
  readAppLive: vi.fn(), writeAppLive: vi.fn(), readConcurrentChart: vi.fn(), writeConcurrentChart: vi.fn(),
}));
vi.mock('../src/lib/store/app-live', () => ({ readAppLive, writeAppLive, readConcurrentChart, writeConcurrentChart }));

beforeEach(() => {
  vi.clearAllMocks();
  readAppLive.mockResolvedValue(new Map());
  readConcurrentChart.mockResolvedValue(undefined);
});

const pool = [100, 200, 300, 400, 500]; // P25=200, P75=400

describe('pool activity bands', () => {
  it('includes both quartile edges and interpolates between observations', () => {
    expect(activityBand(200, pool)).toBe('low');
    expect(activityBand(201, pool)).toBe('mid');
    expect(activityBand(399, pool)).toBe('mid');
    expect(activityBand(400, pool)).toBe('high');
    expect(activityBand(250, [100, 300, 500, 700])).toBe('low');
    expect(activityBand(550, [100, 300, 500, 700])).toBe('high');
  });
  it('enforces the absolute floor, preserves zero and gives unknown counters no badge', () => {
    expect(activityBand(99, [0, 1, 2, 99])).toBe('low');
    expect(activityBand(100, [0, 1, 2, 100])).toBe('high');
    expect(activityBand(0, pool)).toBe('low');
    expect(activityBand(null, pool)).toBeNull();
    expect(activityBand(undefined, pool)).toBeNull();
    expect(activityBand(200, [null, undefined])).toBeNull();
    expect(activityBand(400, [...pool, null])).toBe('high');
  });
  it('uses tunable thresholds and gives high precedence when quartiles tie', () => {
    expect(activityBand(100, [100, 100])).toBe('high');
    expect(activityBand(400, pool, { ...THRESHOLDS, activeMinPlayers: 500 })).toBe('low');
    expect(activityBand(300, pool, { ...THRESHOLDS, activityHighPercentile: 50 })).toBe('high');
    expect(liveSignalsOf(new Map([[1, null], [2, 0]]))).toEqual(new Map([[1, { players: null, band: null }], [2, { players: 0, band: 'low' }]]));
  });
});

describe('current players batch', () => {
  const record = (players: number | null, expiry: number): AppLiveRecord => ({ players, fetchedAt: Timestamp.fromMillis(0), expiresAt: Timestamp.fromMillis(expiry) });
  it('reuses cached counts and absent counters, refreshes at exact expiry and caches for ten minutes', async () => {
    readAppLive.mockResolvedValue(new Map([[1, record(0, 1001)], [2, record(null, 1001)], [3, record(80, 1000)]]));
    const fetch = vi.fn().mockResolvedValue(Response.json({ response: { result: 1, player_count: 500 } }));
    const result = await getCurrentPlayers([1, 2, 3, 3], { now: 1000, client: createSteamClient({ fetch }) });
    expect(result).toEqual({ players: new Map([[1, 0], [2, null], [3, 500]]), unresolved: [], fetched: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = fetch.mock.calls[0][0] as URL;
    expect(url.searchParams.get('appid')).toBe('3');
    expect(url.searchParams.has('key')).toBe(false);
    expect(writeAppLive.mock.calls[0][0].get(3)).toEqual({ ...record(500, 1000 + APP_LIVE_TTL_MS), fetchedAt: Timestamp.fromMillis(1000) });
    expect(writeAppLive.mock.calls[0][0].get(3).fetchedAt.toMillis()).toBe(1000);
  });
  it('caches a confirmed absent counter but leaves transient failures unresolved', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => Number(new URL(String(input)).searchParams.get('appid')) === 1
      ? Response.json({ response: { result: 42 } }, { status: 404 }) : Response.json({}, { status: 500 }));
    const result = await getCurrentPlayers([1, 2], { client: createSteamClient({ fetch, retries: 0 }) });
    expect(result).toMatchObject({ players: new Map([[1, null]]), unresolved: [2], fetched: 1 });
    expect(writeAppLive.mock.calls[0][0].has(2)).toBe(false);
  });
  it('limits a batch to five calls in flight even with a wider shared client', async () => {
    let active = 0;
    let peak = 0;
    const fetch = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return Response.json({ response: { result: 1, player_count: 100 } });
    });
    const result = await getCurrentPlayers(Array.from({ length: 40 }, (_, i) => i + 1), { client: createSteamClient({ fetch, concurrency: 20 }) });
    expect(result.fetched).toBe(40);
    expect(peak).toBe(5);
  });
  it('stops starting calls when the batch time budget is exhausted', async () => {
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const fetch = vi.fn(async () => {
        clock = 20001;
        return Response.json({ response: { result: 1, player_count: 100 } });
      });
      const result = await getCurrentPlayers([1, 2, 3, 4, 5, 6], { now: 0, client: createSteamClient({ fetch }) });
      expect(result.fetched).toBe(1);
      expect(result.unresolved).toEqual([2, 3, 4, 5, 6]);
    } finally { now.mockRestore(); }
  });
  it('treats a failed cache read as a miss and still returns counts when the cache write fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    readAppLive.mockRejectedValueOnce(new Error('firestore down'));
    writeAppLive.mockRejectedValueOnce(new Error('firestore down'));
    const fetch = vi.fn(async () => Response.json({ response: { result: 1, player_count: 500 } }));
    const result = await getCurrentPlayers([1, 2], { client: createSteamClient({ fetch }) });
    expect(result).toEqual({ players: new Map([[1, 500], [2, 500]]), unresolved: [], fetched: 2 });
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
  it('rejects an oversized batch and invalid ids before reading storage', async () => {
    await expect(getCurrentPlayers(Array.from({ length: 41 }, (_, i) => i + 1))).rejects.toThrow();
    await expect(getCurrentPlayers([0])).rejects.toThrow();
    expect(readAppLive).not.toHaveBeenCalled();
  });
});

describe('cheap concurrency prior', () => {
  it('prioritizes only chart games in the candidate pool without treating misses as inactive', () => {
    expect(prefilterByConcurrency([1, 2, 3, 4], [9, 3, 2], 3)).toEqual([3, 2, 1]);
    expect(prefilterByConcurrency([1, 2, 3, 4], [], 40)).toEqual([1, 2, 3, 4]);
  });
  it('caches the top 100 for five minutes and refreshes at expiry', async () => {
    const fetch = vi.fn(async () => Response.json({ response: { ranks: Array.from({ length: 105 }, (_, i) => ({ appid: i + 1, rank: i + 1, concurrent_in_game: 105 - i })) } }));
    const client = createSteamClient({ fetch });
    const chart = await getTopConcurrentApps({ now: 1000, client });
    expect(chart).toHaveLength(100);
    const record = writeConcurrentChart.mock.calls[0][0];
    expect(record.expiresAt.toMillis()).toBe(301000);
    readConcurrentChart.mockResolvedValue(record);
    expect(await getTopConcurrentApps({ now: 300999, client })).toEqual(chart);
    expect(fetch).toHaveBeenCalledTimes(1);
    await getTopConcurrentApps({ now: 301000, client });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('degrades to no prior when Steam is unavailable and does not cache the failure', async () => {
    const fetch = vi.fn(async () => Response.json({}, { status: 503 }));
    expect(await getTopConcurrentApps({ client: createSteamClient({ fetch, retries: 0 }) })).toEqual([]);
    expect(writeConcurrentChart).not.toHaveBeenCalled();
  });
  it('fetches the chart when the cache read fails and returns it when the cache write fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    readConcurrentChart.mockRejectedValueOnce(new Error('firestore down'));
    writeConcurrentChart.mockRejectedValueOnce(new Error('firestore down'));
    const fetch = vi.fn(async () => Response.json({ response: { ranks: [{ appid: 7, rank: 1, concurrent_in_game: 10 }] } }));
    expect(await getTopConcurrentApps({ client: createSteamClient({ fetch }) })).toEqual([7]);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
