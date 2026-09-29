import { Timestamp, type WriteBatch } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { logServerError, type AchievementProgress } from '../steam';
import { getPlayerAchievements } from '../steam/achievements';
import type { SteamClient } from '../steam/client';
import { patchLibIndex, type LibIndexPatch } from '../store/lib-index';
import { paths } from '../store/paths';
import { commitInBatches, getAllInGroups } from '../store/tx';
import { buildAchievementRecord, indexPatchFor, isFresh, type AchievementRecord, type AchievementState, type LockedAchievement } from './model';

// The single writer of `users/{steamId}/achievementProgress/{appid}` and of the `ap/au/at` fields of the library
// index. Readers get `AchievementRecord`s; anything this package did not write (pre-v2 or malformed) reads as null,
// which is stale, so it is refetched and rewritten on first use.

const STATES: readonly AchievementState[] = ['ok', 'no_stats', 'private'];

type StoredRecord = Omit<AchievementRecord, 'expiresAtMs'> & { expiresAt: Timestamp };

function toStored({ expiresAtMs, ...record }: AchievementRecord): StoredRecord {
  return { ...record, expiresAt: Timestamp.fromMillis(expiresAtMs) };
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function readProgress(value: unknown): AchievementProgress | null {
  const progress = value as Partial<AchievementProgress> | null;
  if (!progress || !isCount(progress.unlocked) || !isCount(progress.total) || !isCount(progress.percent)) return null;
  if (progress.total === 0 || progress.unlocked > progress.total) return null;
  return { unlocked: progress.unlocked, total: progress.total, percent: progress.percent };
}

function readLocked(value: unknown): LockedAchievement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item.apiname !== 'string') return [];
    const entry: LockedAchievement = { apiname: item.apiname };
    if (typeof item.name === 'string') entry.name = item.name;
    if (typeof item.description === 'string') entry.description = item.description;
    return [entry];
  });
}

/** Parses a stored document; null when it is missing, pre-v2 or malformed. */
export function fromStored(data: unknown): AchievementRecord | null {
  const raw = data as Partial<StoredRecord> | undefined;
  if (!raw || raw.v !== 2 || !STATES.includes(raw.state as AchievementState) || !(raw.expiresAt instanceof Timestamp)) return null;
  const progress = readProgress(raw.progress);
  if (raw.state === 'ok' && !progress) return null;
  return {
    v: 2,
    state: raw.state as AchievementState,
    progress: raw.state === 'ok' ? progress : null,
    locked: raw.state === 'ok' ? readLocked(raw.locked) : [],
    lockedTruncated: raw.lockedTruncated === true,
    lastUnlockAt: isCount(raw.lastUnlockAt) ? raw.lastUnlockAt : null,
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : '',
    expiresAtMs: raw.expiresAt.toMillis(),
  };
}

const recordRef = (steamId: string, appid: number) => db.doc(paths.achievementProgressDoc(steamId, appid));

/** Stored records for `appids`, in one read each (100 per `getAll`). Missing and unreadable records are null. */
export async function readAchievementRecords(steamId: string, appids: readonly number[]): Promise<Map<number, AchievementRecord | null>> {
  const snapshots = await getAllInGroups(appids.map(appid => recordRef(steamId, appid)));
  return new Map(appids.map((appid, index) => [appid, fromStored(snapshots[index].data())]));
}

export async function readAchievementRecord(steamId: string, appid: number): Promise<AchievementRecord | null> {
  return fromStored((await recordRef(steamId, appid).get()).data());
}

/**
 * One `GetPlayerAchievements` call (with English names and descriptions) turned into a record. Throws the Steam
 * client's error when Steam fails; only Steam's own "no stats" and "private" answers become records.
 */
export async function fetchAchievementRecord(steamId: string, appid: number, now = Date.now(), client?: SteamClient): Promise<AchievementRecord> {
  return buildAchievementRecord(await getPlayerAchievements(steamId, appid, 'english', client), now);
}

/** Patches the index summaries of `records`. Index entries that do not exist yet are skipped, never created. */
export async function patchAchievementIndex(steamId: string, records: ReadonlyMap<number, Pick<AchievementRecord, 'state' | 'progress'>>): Promise<void> {
  if (!records.size) return;
  await patchLibIndex(steamId, new Map<number, LibIndexPatch>([...records].map(([appid, record]) => [appid, indexPatchFor(record)])));
}

/** Writes records, then their index summaries (plus `alsoIndex`, summaries of stored records to re-sync). */
export async function saveAchievementRecords(
  steamId: string, records: ReadonlyMap<number, AchievementRecord>, alsoIndex: ReadonlyMap<number, AchievementRecord> = new Map(),
): Promise<void> {
  const writes = [...records].map(([appid, record]) => (batch: WriteBatch) => { batch.set(recordRef(steamId, appid), toStored(record)); });
  await commitInBatches(writes);
  await patchAchievementIndex(steamId, new Map([...alsoIndex, ...records]));
}

/**
 * Achievement progress for one owned game: the stored record while it is fresh, else a Steam fetch that is stored
 * before it is returned. Games without stats and private achievements give null (cached as negative records); any
 * other Steam failure throws and caches nothing. Keeps the signature of the pre-v2 `achievement-cache.ts`.
 */
export async function getCachedAchievementProgress(steamId: string, appid: number): Promise<AchievementProgress | null> {
  const now = Date.now();
  const ref = recordRef(steamId, appid);
  const cached = fromStored((await ref.get()).data());
  if (cached && isFresh(cached, now)) return cached.progress;
  const record = await fetchAchievementRecord(steamId, appid, now);
  // A failed write only costs a refetch next time; the picker card still gets its answer.
  try {
    await ref.set(toStored(record));
  } catch (error) {
    logServerError('Achievement cache write failed', error);
    return record.progress;
  }
  try {
    await patchLibIndex(steamId, { [appid]: indexPatchFor(record) });
  } catch (error) {
    logServerError('Achievement index update failed', error);
  }
  return record.progress;
}
