import { logServerError } from '../steam';
import { createSemaphore, SteamClientError, type SteamClient } from '../steam/client';
import { readLibIndex } from '../store/lib-index';
import {
  decodeScanCursor, encodeScanCursor, indexMatches, isFresh, planScan, positionAfter,
  type AchievementRecord, type ScanCandidate, type ScanKey,
} from './model';
import { fetchAchievementRecord, isAchievementsPrivate, markAchievementsPrivate, readAchievementRecords, saveAchievementRecords } from './store';

// Incremental achievement scan (decision D13: on demand the first time an achievement mode is used, then refreshed
// by TTL). The client calls it in a loop, passing back the cursor, and shows `progress`. Each call reads the library
// (four index reads), walks forward from the cursor reading the stored records, and fetches at most SCAN_BATCH_SIZE
// games whose records are missing or expired, five at a time. Fresh games cost one read and no Steam call, so re-running a
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
  /** Steam answered "Profile is not public" for achievements, now or within PRIVATE_RECHECK_MS; `cursor` is null. */
  | 'private'
  /** The user's library index is not built yet: sync the library, then scan again. `cursor` is null. */
  | 'needs_sync'
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
  concurrency?: number;
  timeBudgetMs?: number;
  now?: () => number;
  client?: SteamClient;
}

export class InvalidScanCursorError extends Error {
  constructor() { super('Invalid scan cursor'); }
}

export async function scanAchievements(steamId: string, options: ScanOptions = {}): Promise<ScanResult> {
  const clock = options.now ?? Date.now;
  let cursorKey: ScanKey | null = null;
  if (options.cursor) {
    cursorKey = decodeScanCursor(options.cursor);
    if (!cursorKey) throw new InvalidScanCursorError();
  }
  const now = clock();
  const noneFetched = { ok: 0, noStats: 0, private: 0, failed: 0 };
  const [index, isPrivate] = await Promise.all([readLibIndex(steamId), isAchievementsPrivate(steamId, now)]);
  if (!index.built) return { state: 'needs_sync', cursor: null, progress: { done: 0, total: 0 }, fetched: noneFetched };
  const candidates = planScan(index.entries);
  const start = positionAfter(candidates, cursorKey);
  if (isPrivate) return { state: 'private', cursor: null, progress: { done: start, total: candidates.length }, fetched: noneFetched };

  // Walk forward from the cursor until SCAN_BATCH_SIZE games are due or the read allowance is spent.
  const examined: ScanCandidate[] = [];
  const due: ScanCandidate[] = [];
  // Fresh records whose index summary is missing or stale, for example written before the index was built.
  const resync = new Map<number, AchievementRecord>();
  let next = start;
  while (due.length < SCAN_BATCH_SIZE && next < candidates.length && examined.length < SCAN_EXAMINE_LIMIT) {
    const group = candidates.slice(next, Math.min(candidates.length, next + READ_GROUP, start + SCAN_EXAMINE_LIMIT));
    const stored = await readAchievementRecords(steamId, group.map(candidate => candidate.appid));
    for (const candidate of group) {
      examined.push(candidate);
      next++;
      const record = stored.get(candidate.appid) ?? null;
      if (!record || !isFresh(record, now)) due.push(candidate);
      else if (!indexMatches(index.entries.get(candidate.appid) ?? {}, record)) resync.set(candidate.appid, record);
      if (due.length >= SCAN_BATCH_SIZE) break;
    }
  }

  const records = new Map<number, AchievementRecord>();
  const failed = new Set<number>();
  let privateAnswers = 0;
  type Stop = { state: 'private' } | { state: 'rate_limited'; retryAfter: number };
  // Set from inside the fetch callbacks; the cast keeps TypeScript from narrowing it to null for good.
  let stop = null as Stop | null;
  const deadline = clock() + (options.timeBudgetMs ?? SCAN_TIME_BUDGET_MS);
  const fetchOne = async (candidate: ScanCandidate, force = false) => {
    if (stop || (!force && clock() >= deadline)) return;
    try {
      const record = await fetchAchievementRecord(steamId, candidate.appid, clock(), options.client);
      if (record) {
        records.set(candidate.appid, record);
        return;
      }
      privateAnswers++;
      stop ??= { state: 'private' };
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
  if (stop?.state === 'private') await markAchievementsPrivate(steamId, clock());

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
  const fetched = { ok: 0, noStats: 0, private: privateAnswers, failed: failed.size };
  for (const record of records.values()) {
    if (record.state === 'ok') fetched.ok++;
    else fetched.noStats++;
  }
  const progress = { done, total: candidates.length };
  const cursorAt = (position: number) => position > 0 ? encodeScanCursor(candidates[position - 1]) : null;

  if (stop?.state === 'private') return { state: 'private', cursor: null, progress, fetched };
  if (stop?.state === 'rate_limited') return { state: 'rate_limited', cursor: cursorAt(done), progress, fetched, retryAfter: stop.retryAfter };
  if (done >= candidates.length) return { state: 'complete', cursor: null, progress: { done: candidates.length, total: candidates.length }, fetched };
  return { state: 'running', cursor: cursorAt(done), progress, fetched };
}
