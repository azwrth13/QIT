import { FieldValue, type DocumentSnapshot } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { LIB_INDEX_FIELDS, libIndexChunkConverter } from './converters';
import { appIdSegment, paths } from './paths';
import { runTransaction } from './tx';
import type { LibIndexChunk, LibIndexEntry } from './types';

// Compact per-user library index: `users/{steamId}/libIndex/{appid % 4}` holding `games: { "<appid>": entry }`.
// A library load is exactly four reads. Writers patch individual entry fields with merge writes, so packages
// owning different field groups never clobber each other. The `games` map is exempt from indexing in
// firestore.indexes.json; deploy that before the first chunk is written.

export const LIB_INDEX_CHUNKS = 4;
const CHUNKS = Array.from({ length: LIB_INDEX_CHUNKS }, (_, chunk) => chunk);

export function libIndexChunkOf(appid: number): number {
  return Number(appIdSegment(appid)) % LIB_INDEX_CHUNKS;
}

/** A field set to `null` is removed (back to unknown); `undefined` fields are ignored. The name cannot be removed. */
export type LibIndexPatch = { n?: string } & { [K in Exclude<keyof LibIndexEntry, 'n'>]?: LibIndexEntry[K] | null };
export type LibIndexPatches = Map<number, LibIndexPatch> | Record<string, LibIndexPatch>;

export interface LibIndex {
  entries: Map<number, LibIndexEntry>;
  /** false when no chunk exists yet (never synced), as opposed to an empty library */
  built: boolean;
  updatedAt: Date | null;
}

export interface PatchResult {
  applied: number[];
  /** appids not in the index; only an existing-only patch skips anything */
  skipped: number[];
}

const rawChunk = (steamId: string, chunk: number) => db.doc(paths.libIndexChunk(steamId, chunk));
const typedChunk = (steamId: string, chunk: number) => rawChunk(steamId, chunk).withConverter(libIndexChunkConverter);

export async function readLibIndex(steamId: string): Promise<LibIndex> {
  // getAll applies each ref's converter but is not generic in its typings.
  const snapshots = await db.getAll(...CHUNKS.map(chunk => typedChunk(steamId, chunk))) as DocumentSnapshot<LibIndexChunk>[];
  const entries = new Map<number, LibIndexEntry>();
  let built = false;
  let updatedAt: Date | null = null;
  for (const snapshot of snapshots) {
    const chunk = snapshot.data();
    if (!chunk) continue;
    built = true;
    for (const [appid, entry] of Object.entries(chunk.games)) entries.set(Number(appid), entry);
    const at = chunk.updatedAt?.toDate();
    if (at && (!updatedAt || at > updatedAt)) updatedAt = at;
  }
  return { entries, built, updatedAt };
}

type ChunkPlan = Map<number, Map<number, Record<string, unknown>>>;

/** Validates patches and groups them by chunk. Pure; exported for tests. */
export function planLibIndexPatch(patches: LibIndexPatches, requireName: boolean): ChunkPlan {
  const plan: ChunkPlan = new Map();
  const list = patches instanceof Map ? [...patches] : Object.entries(patches);
  for (const [key, patch] of list) {
    const appid = Number(appIdSegment(key));
    const fields: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!LIB_INDEX_FIELDS.includes(field as keyof LibIndexEntry)) throw new Error(`Unknown library index field ${field}`);
      const valid = field === 'n' ? typeof value === 'string'
        : value === null || (field === 'i' ? typeof value === 'string' : typeof value === 'number' && Number.isFinite(value));
      if (!valid) throw new Error(`Invalid value for library index field ${field}`);
      fields[field] = value === null ? FieldValue.delete() : value;
    }
    if (requireName && typeof fields.n !== 'string') throw new Error('Creating a library index entry requires a name');
    if (!Object.keys(fields).length) continue;
    const chunk = appid % LIB_INDEX_CHUNKS;
    if (!plan.has(chunk)) plan.set(chunk, new Map());
    plan.get(chunk)!.set(appid, fields);
  }
  return plan;
}

// With `merge: true` Firestore writes only the leaf fields present, so `games.<appid>.<field>` is patched in place.
function chunkWrite(entries: Map<number, Record<string, unknown>>) {
  return { games: Object.fromEntries(entries), updatedAt: FieldValue.serverTimestamp() };
}

/**
 * Patches entry fields. By default only entries already in the index are touched (one transaction, one read per
 * chunk touched), so a late writer can never resurrect a game the library sync removed. The library sync, which
 * owns entry existence, passes `create: true` to upsert blindly without reading; every created entry needs `n`.
 */
export async function patchLibIndex(steamId: string, patches: LibIndexPatches, { create = false } = {}): Promise<PatchResult> {
  const plan = planLibIndexPatch(patches, create);
  if (!plan.size) return { applied: [], skipped: [] };
  if (create) {
    const batch = db.batch();
    for (const [chunk, entries] of plan) batch.set(rawChunk(steamId, chunk), chunkWrite(entries), { merge: true });
    await batch.commit();
    return { applied: [...plan.values()].flatMap(entries => [...entries.keys()]), skipped: [] };
  }
  return runTransaction(async tx => {
    const result: PatchResult = { applied: [], skipped: [] };
    const chunks = [...plan.keys()];
    const snapshots = await tx.getAll(...chunks.map(chunk => typedChunk(steamId, chunk)));
    chunks.forEach((chunk, index) => {
      const existing = snapshots[index].data()?.games ?? {};
      const kept = new Map<number, Record<string, unknown>>();
      for (const [appid, fields] of plan.get(chunk)!) {
        if (String(appid) in existing) { kept.set(appid, fields); result.applied.push(appid); } else result.skipped.push(appid);
      }
      if (kept.size) tx.set(rawChunk(steamId, chunk), chunkWrite(kept), { merge: true });
    });
    return result;
  });
}

/** Removes whole entries. Missing chunks are left missing. Returns the appids that were present. */
export async function removeFromLibIndex(steamId: string, appids: number[]): Promise<number[]> {
  const plan = new Map<number, Set<number>>();
  for (const id of appids) {
    const appid = Number(appIdSegment(id));
    const chunk = appid % LIB_INDEX_CHUNKS;
    if (!plan.has(chunk)) plan.set(chunk, new Set());
    plan.get(chunk)!.add(appid);
  }
  if (!plan.size) return [];
  return runTransaction(async tx => {
    const removed: number[] = [];
    const chunks = [...plan.keys()];
    const snapshots = await tx.getAll(...chunks.map(chunk => rawChunk(steamId, chunk)));
    chunks.forEach((chunk, index) => {
      const games = snapshots[index].data()?.games;
      if (!games || typeof games !== 'object') return;
      const deletes = new Map<number, FieldValue>();
      for (const appid of plan.get(chunk)!) if (String(appid) in games) { deletes.set(appid, FieldValue.delete()); removed.push(appid); }
      if (deletes.size) tx.set(rawChunk(steamId, chunk), { games: Object.fromEntries(deletes), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    return removed;
  });
}
