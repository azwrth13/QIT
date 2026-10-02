import { Timestamp } from 'firebase-admin/firestore';
import { THRESHOLDS } from '../roulette/thresholds';
import type { ActivityBand, LiveSignals, Thresholds } from '../roulette/types';
import { getCurrentPlayers as fetchCurrentPlayers, getGamesByConcurrentPlayers } from '../steam/charts';
import { getSteamClient, type SteamClient } from '../steam/client';
import { readAppLive, readConcurrentChart, writeAppLive, writeConcurrentChart } from '../store/app-live';
import { isExpired } from '../store/converters';
import { appIdSegment } from '../store/paths';
import type { AppLiveRecord } from '../store/types';

export const APP_LIVE_TTL_MS = 10 * 60 * 1000;
export const CONCURRENT_CHART_TTL_MS = 5 * 60 * 1000;
export const PLAYER_BATCH_LIMIT = 40;
export const PLAYER_BATCH_CONCURRENCY = 5;
/** Stop starting new calls after 20s; shared Steam calls have their own 25s deadline. */
export const PLAYER_BATCH_START_BUDGET_MS = 20_000;

const knownCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Linear interpolation between sorted observations, with endpoints inclusive. */
function percentile(sorted: number[], percent: number): number {
  const position = (sorted.length - 1) * percent / 100;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

/** Unknown counters have no badge; below the absolute active floor is always low. High wins tied quartiles. */
export function activityBand(players: number | null | undefined, pool: readonly (number | null | undefined)[], thresholds: Readonly<Thresholds> = THRESHOLDS): ActivityBand | null {
  if (!knownCount(players)) return null;
  if (players < thresholds.activeMinPlayers) return 'low';
  const sorted = pool.filter(knownCount).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (players >= percentile(sorted, thresholds.activityHighPercentile)) return 'high';
  if (players <= percentile(sorted, thresholds.activityLowPercentile)) return 'low';
  return 'mid';
}

export interface CurrentPlayersResult {
  players: Map<number, number | null>;
  /** Failed or unattempted counters, distinct from a confirmed absent counter. */
  unresolved: number[];
  fetched: number;
}

/** At most 40 distinct apps, five workers, shared Steam timeout/retry/semaphore, and a 10-minute persistent cache. */
export async function getCurrentPlayers(appids: readonly number[], options: { client?: SteamClient; now?: number } = {}): Promise<CurrentPlayersResult> {
  const unique = [...new Set(appids)];
  if (unique.length > PLAYER_BATCH_LIMIT) throw new Error('Too many app IDs');
  unique.forEach(appIdSegment);
  const now = options.now ?? Date.now();
  const cached = await readAppLive(unique);
  const players = new Map<number, number | null>();
  const pending: number[] = [];
  for (const appid of unique) {
    const record = cached.get(appid);
    if (record && (record.players === null || knownCount(record.players)) && !isExpired(record.expiresAt, now)) players.set(appid, record.players);
    else pending.push(appid);
  }
  const writes = new Map<number, AppLiveRecord>();
  const started = Date.now();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(PLAYER_BATCH_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length && Date.now() - started < PLAYER_BATCH_START_BUDGET_MS) {
      const appid = pending[cursor++];
      let count: number | null;
      try { count = await fetchCurrentPlayers(appid, options.client); } catch { continue; }
      players.set(appid, count);
      writes.set(appid, { players: count, fetchedAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(now + APP_LIVE_TTL_MS) });
    }
  }));
  await writeAppLive(writes);
  return { players, unresolved: unique.filter(appid => !players.has(appid)), fetched: writes.size };
}

/** Compute bands after gathering the entire pool, never independently for each fetch chunk. */
export function liveSignalsOf(players: ReadonlyMap<number, number | null>, thresholds: Readonly<Thresholds> = THRESHOLDS): Map<number, LiveSignals> {
  const pool = [...players.values()];
  return new Map([...players].map(([appid, count]) => [appid, { players: count, band: activityBand(count, pool, thresholds) }]));
}

/** One cheap keyless chart call, cached persistently for five minutes. A failed refresh returns no prior. */
export async function getTopConcurrentApps(options: { client?: SteamClient; now?: number } = {}): Promise<number[]> {
  const now = options.now ?? Date.now();
  const cached = await readConcurrentChart();
  if (cached && !isExpired(cached.expiresAt, now)) return cached.appids;
  let chart;
  try { chart = await getGamesByConcurrentPlayers(options.client ?? getSteamClient()); } catch { return []; }
  const appids = [...new Set(chart.ranks.filter(rank => knownCount(rank.concurrent_in_game))
    .sort((a, b) => b.concurrent_in_game - a.concurrent_in_game).map(rank => rank.appid))].slice(0, 100);
  await writeConcurrentChart({ appids, fetchedAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(now + CONCURRENT_CHART_TTL_MS) });
  return appids;
}

/** Cheap prior for bounded enrichment: chart games first, then the rest in original order. Never excludes a chart miss. */
export function prefilterByConcurrency(appids: readonly number[], chart: readonly number[], limit = PLAYER_BATCH_LIMIT): number[] {
  const candidates = new Set(appids);
  return [...new Set([...chart.filter(appid => candidates.has(appid)), ...appids])].slice(0, limit);
}
