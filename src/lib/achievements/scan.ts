import { db } from '../firestore';
import { logServerError } from '../steam';
import { createSemaphore, SteamClientError, type SteamClient } from '../steam/client';
import { readLibIndex } from '../store/lib-index';
import { paths } from '../store/paths';
import {
  decodeScanCursor, encodeScanCursor, indexMatches, isFresh, planScan, positionAfter,
  type AchievementRecord, type ScanCandidate, type ScanIndexEntry, type ScanKey,
} from './model';
import { fetchAchievementRecord, readAchievementRecords, saveAchievementRecords } from './store';

// Incremental achievement scan (decision D13: on demand the first time an achievement mode is used, then refreshed
// by TTL). The client calls it in a loop, passing back the cursor, and shows `progress`. Each call reads the library
// (four index reads), walks forward from the cursor reading the stored records, and fetches at most `limit` games
// whose records are missing or expired, five at a time. Fresh games cost one read and no Steam call, so re-running a
// finished scan only refreshes what expired.

export const SCAN_BATCH_SIZE = 15;
export const SCAN_CONCURRENCY = 5;
/** Stored records read per call at most, so a mostly fresh library still returns quickly. */
export const SCAN_EXAMINE_LIMIT = 120;
/** No new Steam call starts after this; with the client's 25 s call deadline a call stays well under 60 s. */
export const SCAN_TIME_BUDGET_MS = 15_000;
const READ_GROUP = 30;
const RATE_LIMIT_RETRY_SECONDS = 30;
const BUDGET_RETRY_SECONDS = 3600;

export type ScanState =
  /** More to do: call again with `cursor`. */
  | 'running'
  /** The pass is finished; `cursor` is null. */
  | 'complete'
  /** Steam answered "Profile is not public" for achievements; the pass stops and `cursor` is null. */
  | 'private'
  /** Steam throttled us or the daily key budget ran out: call again with `cursor` after `retryAfter` seconds. */
  | 'rate_limited';

export interface ScanResult {
  state: ScanState;
  /** Pass back to continue. Null when the pass is over, or (only with `rate_limited`) to restart from the top. */
  cursor: string | null;
  /** Games of the pass behind the cursor, out of every game the pass covers. */
  progress: { done: number; total: number };
  /** Steam answers stored by this call, and games whose fetch failed (retried on a later pass). */
  fetched: { ok: number; noStats: number; private: number; failed: number };
  retryAfter?: number;
}

export interface ScanOptions {
  cursor?: string | null;
  limit?: number;
  concurrency?: number;
  timeBudgetMs?: number;
  now?: () => number;
  client?: SteamClient;
}

/**
 * The games the scan covers, with the index fields it orders them by. Before the library index is built (users who
 * have not resynced since it landed) the per-game documents are read instead.
 */
export async function loadScanLibrary(steamId: string): Promise<{ entries: Array<[number, ScanIndexEntry]>; indexed: boolean }> {
  const index = await readLibIndex(steamId);
  if (index.built) return { entries: [...index.entries], indexed: true };
  const snapshot = await db.collection(paths.userGames(steamId)).select('playtime_forever', 'has_community_visible_stats').get();
  const entries = snapshot.docs.flatMap(doc => {
    const appid = Number(doc.id);
    if (!Number.isSafeInteger(appid) || appid <= 0) return [];
    const data = doc.data();
    const entry: ScanIndexEntry = {};
    if (typeof data.playtime_forever === 'number') entry.p = data.playtime_forever;
    if (typeof data.has_community_visible_stats === 'boolean') entry.s = data.has_community_visible_stats ? 1 : 0;
    return [[appid, entry] as [number, ScanIndexEntry]];
  });
  return { entries, indexed: false };
}

export class InvalidScanCursorError extends Error {
  constructor() { super('Invalid scan cursor'); }
}

export async function scanAchievements(steamId: string, options: ScanOptions = {}): Promise<ScanResult> {
  const clock = options.now ?? Date.now;
  const limit = Math.max(1, Math.min(SCAN_BATCH_SIZE, options.limit ?? SCAN_BATCH_SIZE));
  let cursorKey: ScanKey | null = null;
  if (options.cursor) {
    cursorKey = decodeScanCursor(options.cursor);
    if (!cursorKey) throw new InvalidScanCursorError();
  }
  const library = await loadScanLibrary(steamId);
  const indexEntries = new Map(library.entries);
  const candidates = planScan(library.entries);
  const start = positionAfter(candidates, cursorKey);
  const now = clock();

  // Walk forward from the cursor until `limit` games are due or the read allowance is spent.
  const examined: ScanCandidate[] = [];
  const due: ScanCandidate[] = [];
  // Fresh records whose index summary is missing or stale, for example written before the index was built.
  const resync = new Map<number, AchievementRecord>();
  let next = start;
  while (due.length < limit && next < candidates.length && examined.length < SCAN_EXAMINE_LIMIT) {
    const group = candidates.slice(next, Math.min(candidates.length, next + READ_GROUP, start + SCAN_EXAMINE_LIMIT));
    const stored = await readAchievementRecords(steamId, group.map(candidate => candidate.appid));
    for (const candidate of group) {
      examined.push(candidate);
      next++;
      const record = stored.get(candidate.appid) ?? null;
      if (!record || !isFresh(record, now)) due.push(candidate);
      else if (library.indexed && !indexMatches(indexEntries.get(candidate.appid) ?? {}, record)) resync.set(candidate.appid, record);
      if (due.length >= limit) break;
    }
  }

  const records = new Map<number, AchievementRecord>();
  const failed = new Set<number>();
  type Stop = { state: 'private' } | { state: 'rate_limited'; retryAfter: number };
  // Set from inside the fetch callbacks; the cast keeps TypeScript from narrowing it to null for good.
  let stop = null as Stop | null;
  const deadline = clock() + (options.timeBudgetMs ?? SCAN_TIME_BUDGET_MS);
  const fetchOne = async (candidate: ScanCandidate, force = false) => {
    if (stop || (!force && clock() >= deadline)) return;
    try {
      const record = await fetchAchievementRecord(steamId, candidate.appid, clock(), options.client);
      records.set(candidate.appid, record);
      if (record.state === 'private') stop ??= { state: 'private' };
    } catch (error) {
      if (error instanceof SteamClientError && (error.kind === 'rate_limited' || error.kind === 'budget_exhausted')) {
        stop ??= { state: 'rate_limited', retryAfter: error.retryAfterSeconds
          ?? (error.kind === 'budget_exhausted' ? BUDGET_RETRY_SECONDS : RATE_LIMIT_RETRY_SECONDS) };
        return;
      }
      logServerError('Achievement scan fetch failed', error);
      failed.add(candidate.appid);
    }
  };
  // Probe with one game first: a private profile or a throttled key then costs one call, not five.
  if (due.length) await fetchOne(due[0], true);
  const semaphore = createSemaphore(Math.max(1, options.concurrency ?? SCAN_CONCURRENCY));
  await Promise.all(due.slice(1).map(candidate => semaphore.run(() => fetchOne(candidate))));

  await saveAchievementRecords(steamId, records, resync);

  // The cursor moves past the longest run of examined games that are settled (fresh, stored or failed), so games
  // skipped by a stop or the time budget come first on the next call.
  const dueIds = new Set(due.map(candidate => candidate.appid));
  let settled = 0;
  while (settled < examined.length) {
    const appid = examined[settled].appid;
    if (dueIds.has(appid) && !records.has(appid) && !failed.has(appid)) break;
    settled++;
  }
  const done = start + settled;
  const fetched = { ok: 0, noStats: 0, private: 0, failed: failed.size };
  for (const record of records.values()) {
    if (record.state === 'ok') fetched.ok++;
    else if (record.state === 'no_stats') fetched.noStats++;
    else fetched.private++;
  }
  const progress = { done, total: candidates.length };
  const cursorAt = (position: number) => position > 0 ? encodeScanCursor(candidates[position - 1]) : null;

  if (stop?.state === 'private') return { state: 'private', cursor: null, progress, fetched };
  if (stop?.state === 'rate_limited') return { state: 'rate_limited', cursor: cursorAt(done), progress, fetched, retryAfter: stop.retryAfter };
  if (done >= candidates.length) return { state: 'complete', cursor: null, progress: { done: candidates.length, total: candidates.length }, fetched };
  return { state: 'running', cursor: cursorAt(done), progress, fetched };
}
