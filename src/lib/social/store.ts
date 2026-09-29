import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { stripUndefined } from '../store/converters';
import { readLibIndex } from '../store/lib-index';
import { MAX_DOCUMENT_BYTES, MAX_INDEX_ENTRIES, documentSize, estimateIndexEntries } from '../store/limits';
import { paths } from '../store/paths';
import { getAllInGroups, runTransaction } from '../store/tx';
import type { FriendsMetaRecord, FriendSummaryRecord, LibIndexEntry, PinnedMetaRecord, PublicLibraryRecord } from '../store/types';
import { isSteamId } from '../steam';

// The Firestore side of the social data. Everything above this file (`friends.ts`, `pinned.ts`,
// `libraries.ts`) talks to the `SocialStore` interface, so unit tests use an in-memory store and the
// emulator tests cover this implementation.

export interface QitLibrary {
  games: Map<number, LibIndexEntry>;
  /** When the index was last written (ms), or null when unknown. */
  updatedAt: number | null;
}

export interface SocialStore {
  readFriends(steamId: string): Promise<FriendsMetaRecord | null>;
  writeFriends(steamId: string, record: FriendsMetaRecord): Promise<void>;
  readPinned(steamId: string): Promise<string[]>;
  /** Transactional read-modify-write of the pinned ids. `change` returns the new list, or null to leave it as it is. */
  updatePinned(steamId: string, change: (ids: string[]) => string[] | null): Promise<string[]>;
  readPublicLibraries(ids: string[]): Promise<Map<string, PublicLibraryRecord>>;
  writePublicLibrary(steamId: string, record: PublicLibraryRecord): Promise<void>;
  /** QIT users whose library index is built and whose profile is not known to be private. */
  readQitLibraries(ids: string[]): Promise<Map<string, QitLibrary>>;
  /** Marks a QIT user's profile as not public, so their stored library index is not reused until they sign in again. */
  markNotPublic(steamId: string): Promise<void>;
}

/** Room left under Firestore's limits for the field names and metadata this estimate does not see. */
const SIZE_MARGIN = 0.95;

/** Whether a document stays inside Firestore's size and index-entry limits. Oversized cache documents are skipped, not written. */
export function fitsInDocument(path: string, data: Record<string, unknown>): boolean {
  return documentSize(path, data) <= MAX_DOCUMENT_BYTES * SIZE_MARGIN && estimateIndexEntries(data) <= MAX_INDEX_ENTRIES * SIZE_MARGIN;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseSummary(raw: unknown): FriendSummaryRecord | null {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null;
  const summary: FriendSummaryRecord = {
    name: raw.name,
    url: typeof raw.url === 'string' ? raw.url : '',
    avatar: typeof raw.avatar === 'string' ? raw.avatar : '',
  };
  if (typeof raw.avatarMedium === 'string') summary.avatarMedium = raw.avatarMedium;
  if (finite(raw.status)) summary.status = raw.status;
  if (finite(raw.gameId)) summary.gameId = raw.gameId;
  if (typeof raw.game === 'string') summary.game = raw.game;
  return summary;
}

/** Returns a clean record, or null when the stored document is not a usable snapshot. Exported for tests. */
export function parseFriendsRecord(raw: unknown): FriendsMetaRecord | null {
  if (!isRecord(raw) || !(raw.fetchedAt instanceof Timestamp)) return null;
  if (raw.state !== 'ok' && raw.state !== 'private') return null;
  if (!Array.isArray(raw.ids) || !isRecord(raw.summaries)) return null;
  const summaries: Record<string, FriendSummaryRecord> = {};
  for (const [id, value] of Object.entries(raw.summaries)) {
    const summary = isSteamId(id) ? parseSummary(value) : null;
    if (summary) summaries[id] = summary;
  }
  return { ids: raw.ids.filter(isSteamId), summaries, state: raw.state, fetchedAt: raw.fetchedAt };
}

/** Exported for tests. */
export function parsePinnedIds(raw: unknown): string[] {
  const ids = isRecord(raw) && Array.isArray(raw.ids) ? raw.ids.filter(isSteamId) : [];
  return [...new Set(ids)];
}

function parsePublicLibrary(raw: unknown): PublicLibraryRecord | null {
  if (!isRecord(raw) || !(raw.fetchedAt instanceof Timestamp) || !(raw.expiresAt instanceof Timestamp)) return null;
  if (raw.state !== 'ok' && raw.state !== 'private' && raw.state !== 'not_found' && raw.state !== 'error') return null;
  return { state: raw.state, games: typeof raw.games === 'string' ? raw.games : '', fetchedAt: raw.fetchedAt, expiresAt: raw.expiresAt };
}

export const firestoreSocialStore: SocialStore = {
  async readFriends(steamId) {
    return parseFriendsRecord((await db.doc(paths.friendsMeta(steamId)).get()).data());
  },

  async writeFriends(steamId, record) {
    const path = paths.friendsMeta(steamId);
    const data = stripUndefined({ ...record });
    if (fitsInDocument(path, data)) await db.doc(path).set(data);
  },

  async readPinned(steamId) {
    return parsePinnedIds((await db.doc(paths.pinnedMeta(steamId)).get()).data());
  },

  async updatePinned(steamId, change) {
    const ref = db.doc(paths.pinnedMeta(steamId));
    return runTransaction(async tx => {
      const ids = parsePinnedIds((await tx.get(ref)).data());
      const next = change(ids);
      if (next === null) return ids;
      const record: PinnedMetaRecord = { ids: next, updatedAt: Timestamp.now() };
      tx.set(ref, record);
      return next;
    });
  },

  async readPublicLibraries(ids) {
    const snapshots = await getAllInGroups(ids.map(id => db.doc(paths.publicLibrary(id))));
    const records = new Map<string, PublicLibraryRecord>();
    snapshots.forEach((snapshot, index) => {
      const record = parsePublicLibrary(snapshot.data());
      if (record) records.set(ids[index], record);
    });
    return records;
  },

  async writePublicLibrary(steamId, record) {
    const path = paths.publicLibrary(steamId);
    const data = { ...record };
    if (fitsInDocument(path, data)) await db.doc(path).set(data);
  },

  async readQitLibraries(ids) {
    const users = await getAllInGroups(ids.map(id => db.doc(paths.user(id))));
    // `public` is what the last sign-in or library refresh saw. When it says private, ask Steam instead of trusting an older index.
    const candidates = ids.filter((_, index) => users[index].exists && users[index].data()?.public !== false);
    const libraries = new Map<string, QitLibrary>();
    await Promise.all(candidates.map(async id => {
      const index = await readLibIndex(id);
      if (index.built) libraries.set(id, { games: index.entries, updatedAt: index.updatedAt?.getTime() ?? null });
    }));
    return libraries;
  },

  async markNotPublic(steamId) {
    await db.doc(paths.user(steamId)).update({ public: false });
  },
};
