import type { AchievementSignals } from '../roulette/types';
import type { AchievementProgress } from '../steam';
import type { PlayerAchievementsResult } from '../steam/achievements';
import type { LibIndexEntry } from '../store/types';
import type { LibIndexPatch } from '../store/lib-index';

// Pure achievement model: what one `GetPlayerAchievements` answer becomes on disk, how long it stays fresh, what it
// patches into the library index, and the order and cursor of the incremental scan. No Firestore, no fetch.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Freshness per state (report section 3). Achievements can be private while owned games are public (live check in
 * docs/features/qit-steam-client.md), and a user who sees "your achievements are private" can fix that in a minute,
 * so a private answer is cached only briefly; "no stats" is a property of the app and is cached for the full week.
 */
export const ACHIEVEMENT_TTL_MS = {
  inProgress: DAY,
  complete: 30 * DAY,
  noStats: 7 * DAY,
  private: HOUR,
} as const;

/** Locked achievements kept per game, with capped text, so one document stays far below Firestore's 1 MiB. */
export const MAX_LOCKED_STORED = 1000;
const MAX_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 256;
const MAX_APINAME_CHARS = 128;

export type AchievementState = 'ok' | 'no_stats' | 'private';

export interface LockedAchievement {
  apiname: string;
  /** English display name, when Steam sent one. */
  name?: string;
  /** English description; absent for hidden achievements, whose description Steam blanks. */
  description?: string;
}

/**
 * `users/{steamId}/achievementProgress/{appid}`, written only by `src/lib/achievements/store.ts`. `progress` and
 * `fetchedAt` keep the pre-v2 shape so older readers still work; `v: 2` marks the records this package wrote.
 */
export interface AchievementRecord {
  v: 2;
  state: AchievementState;
  /** null unless `state` is `ok`. */
  progress: AchievementProgress | null;
  /** Locked achievements in Steam's order (`ok` only). */
  locked: LockedAchievement[];
  /** True when more than MAX_LOCKED_STORED were locked and the list was cut. */
  lockedTruncated: boolean;
  /** Unix seconds of the newest unlock; null when nothing is unlocked or the state is not `ok`. */
  lastUnlockAt: number | null;
  /** ISO time of the Steam answer (pre-v2 field). */
  fetchedAt: string;
  /** Epoch ms after which the record must be refetched. Stored as a Firestore Timestamp. */
  expiresAtMs: number;
}

const clip = (value: string, max: number) => value.length > max ? value.slice(0, max) : value;

export function ttlFor(state: AchievementState, progress: AchievementProgress | null): number {
  if (state === 'private') return ACHIEVEMENT_TTL_MS.private;
  if (state === 'no_stats' || !progress) return ACHIEVEMENT_TTL_MS.noStats;
  return progress.unlocked >= progress.total ? ACHIEVEMENT_TTL_MS.complete : ACHIEVEMENT_TTL_MS.inProgress;
}

/** Percent is floored, so a game is only 100% when every achievement is unlocked (same rule as before v2). */
export function progressOf(unlocked: number, total: number): AchievementProgress {
  return { unlocked, total, percent: Math.floor((unlocked / total) * 100) };
}

export function buildAchievementRecord(result: PlayerAchievementsResult, now: number): AchievementRecord {
  const base = { v: 2 as const, fetchedAt: new Date(now).toISOString() };
  if (result.state !== 'ok') {
    return { ...base, state: result.state, progress: null, locked: [], lockedTruncated: false, lastUnlockAt: null,
      expiresAtMs: now + ttlFor(result.state, null) };
  }
  const { achievements } = result;
  const unlocked = achievements.filter(achievement => achievement.achieved);
  const progress = progressOf(unlocked.length, achievements.length);
  const lastUnlockAt = unlocked.reduce<number | null>((latest, achievement) =>
    achievement.unlocktime !== null && (latest === null || achievement.unlocktime > latest) ? achievement.unlocktime : latest, null);
  const lockedAll = achievements.filter(achievement => !achievement.achieved);
  const locked = lockedAll.slice(0, MAX_LOCKED_STORED).map(achievement => {
    const entry: LockedAchievement = { apiname: clip(achievement.apiname, MAX_APINAME_CHARS) };
    if (achievement.name) entry.name = clip(achievement.name, MAX_NAME_CHARS);
    if (achievement.description) entry.description = clip(achievement.description, MAX_DESCRIPTION_CHARS);
    return entry;
  });
  return { ...base, state: 'ok', progress, locked, lockedTruncated: lockedAll.length > locked.length, lastUnlockAt,
    expiresAtMs: now + ttlFor('ok', progress) };
}

/** A record is fresh until its expiry. Pre-v2 records (no `v`) are always stale, so they migrate on first use. */
export function isFresh(record: Pick<AchievementRecord, 'expiresAtMs'> | null, now: number): boolean {
  return !!record && record.expiresAtMs > now;
}

/**
 * The library index summary for a record: `ap/au/at` for known progress, `at: 0` for a game known to have no
 * achievements, and all three cleared (unknown) when the answer was private.
 */
export function indexPatchFor(record: Pick<AchievementRecord, 'state' | 'progress'>): LibIndexPatch {
  if (record.state === 'ok' && record.progress) {
    return { ap: record.progress.percent, au: record.progress.unlocked, at: record.progress.total };
  }
  if (record.state === 'no_stats') return { ap: null, au: null, at: 0 };
  return { ap: null, au: null, at: null };
}

/** Whether an index entry already carries the summary of `record` (so no patch is needed). */
export function indexMatches(entry: Pick<LibIndexEntry, 'ap' | 'au' | 'at'>, record: Pick<AchievementRecord, 'state' | 'progress'>): boolean {
  const patch = indexPatchFor(record);
  return (['ap', 'au', 'at'] as const).every(field => (entry[field] ?? null) === (patch[field] ?? null));
}

/** Roulette signals for one game: null means no achievement data (no stats, private, or not scanned yet). */
export function toAchievementSignals(record: Pick<AchievementRecord, 'state' | 'progress' | 'lastUnlockAt'> | null): AchievementSignals | null {
  if (!record || record.state !== 'ok' || !record.progress) return null;
  const { unlocked, total, percent } = record.progress;
  return { total, unlocked, percent, lockedRare: null, lastUnlockAt: record.lastUnlockAt };
}

/** The same signals read from a library index entry alone, without the per-game document. */
export function achievementSignalsFromIndex(entry: Pick<LibIndexEntry, 'ap' | 'au' | 'at'>): AchievementSignals | null {
  if (typeof entry.at !== 'number' || entry.at <= 0 || typeof entry.au !== 'number') return null;
  const percent = typeof entry.ap === 'number' ? entry.ap : progressOf(entry.au, entry.at).percent;
  return { total: entry.at, unlocked: entry.au, percent, lockedRare: null, lastUnlockAt: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Scan order and cursor

/**
 * Bits of the index `f` field that the scan reads, as defined by qit-app-metadata (`STORE_FLAG_BITS` in
 * src/lib/apps/metadata.ts): `known` is set once Steam gave category data, `achievements` is store category 22.
 */
const STORE_FLAG_KNOWN = 1 << 0;
const STORE_FLAG_ACHIEVEMENTS = 1 << 6;

/** An index entry as the scan reads it; `s` is qit-library-model's `has_community_visible_stats` (1 or 0). */
export type ScanIndexEntry = Pick<LibIndexEntry, 'p' | 'f' | 'ap' | 'au' | 'at'> & { s?: number };

/**
 * Whether a game can have achievements, from what the library already knows: the store's achievements category when
 * metadata is cached, else Steam's community-stats flag from the owned-games sync. null means unknown.
 */
export function achievementSupportHint(entry: ScanIndexEntry): boolean | null {
  if (typeof entry.f === 'number' && (entry.f & STORE_FLAG_KNOWN) !== 0) return (entry.f & STORE_FLAG_ACHIEVEMENTS) !== 0;
  if (entry.s === 1) return true;
  if (entry.s === 0) return false;
  return null;
}

export interface ScanCandidate {
  appid: number;
  /** playtime_forever in minutes; 0 when unknown. */
  playtime: number;
  /** 0: known to support achievements, 1: unknown. Games known not to support them are left out of the scan. */
  tier: 0 | 1;
}

export type ScanKey = readonly [tier: number, playtime: number, appid: number];

export const scanKeyOf = (candidate: ScanCandidate): ScanKey => [candidate.tier, candidate.playtime, candidate.appid];

/** Scan order: known achievement games first, then most played, then appid, so the order is total and stable. */
export function compareScanKeys(a: ScanKey, b: ScanKey): number {
  return a[0] - b[0] || b[1] - a[1] || a[2] - b[2];
}

/** Orders a library for scanning. Games the hint rules out are dropped; the single-game route still covers them. */
export function planScan(library: Iterable<[number, ScanIndexEntry]>): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];
  for (const [appid, entry] of library) {
    const hint = achievementSupportHint(entry);
    if (hint === false) continue;
    const playtime = typeof entry.p === 'number' && Number.isFinite(entry.p) && entry.p > 0 ? Math.floor(entry.p) : 0;
    candidates.push({ appid, playtime, tier: hint ? 0 : 1 });
  }
  return candidates.sort((a, b) => compareScanKeys(scanKeyOf(a), scanKeyOf(b)));
}

/** Index of the first candidate after `cursor` (keyset pagination, so a resync between batches never breaks it). */
export function positionAfter(candidates: readonly ScanCandidate[], cursor: ScanKey | null): number {
  if (!cursor) return 0;
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareScanKeys(scanKeyOf(candidates[mid]), cursor) <= 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

const CURSOR_PREFIX = 'a1.';
const MAX_CURSOR_LENGTH = 128;

export function encodeScanCursor(candidate: ScanCandidate): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(scanKeyOf(candidate))).toString('base64url');
}

/** Parses an opaque cursor; null when it is malformed. */
export function decodeScanCursor(cursor: string): ScanKey | null {
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH || !cursor.startsWith(CURSOR_PREFIX)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const [tier, playtime, appid] = parsed as number[];
  if (tier > 1 || appid <= 0) return null;
  return [tier, playtime, appid];
}

