import { Timestamp, type DocumentData, type FirestoreDataConverter, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { LibIndexChunk, LibIndexEntry } from './types';

/** Drops `undefined` values (Firestore rejects them) from plain objects, recursively. Leaves Firestore values alone. */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, stripUndefined(v)])) as T;
}

/** Typed pass-through converter: `db.doc(paths.roll(id, rollId)).withConverter(recordConverter<RollRecord>())`. */
export function recordConverter<T extends DocumentData>(): FirestoreDataConverter<T> {
  return {
    toFirestore: (record: T) => stripUndefined(record),
    fromFirestore: (snapshot: QueryDocumentSnapshot) => snapshot.data() as T,
  };
}

const STRING_FIELDS = ['n', 'i'] as const;
const NUMBER_FIELDS = ['p', 'w', 'r', 'f', 'ap', 'au', 'at'] as const;
export const LIB_INDEX_FIELDS: ReadonlyArray<keyof LibIndexEntry> = [...STRING_FIELDS, ...NUMBER_FIELDS];

/** Returns a clean entry, or null when the raw value has no name (not a usable entry). Malformed fields are dropped as unknown. */
export function toLibIndexEntry(raw: unknown): LibIndexEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.n !== 'string') return null;
  const entry: LibIndexEntry = { n: source.n };
  if (typeof source.i === 'string') entry.i = source.i;
  for (const field of NUMBER_FIELDS) {
    const value = source[field];
    if (typeof value === 'number' && Number.isFinite(value)) entry[field] = value;
  }
  return entry;
}

export const libIndexChunkConverter: FirestoreDataConverter<LibIndexChunk> = {
  toFirestore: (chunk: LibIndexChunk) => stripUndefined(chunk),
  fromFirestore: (snapshot: QueryDocumentSnapshot) => {
    const data = snapshot.data();
    const games: Record<string, LibIndexEntry> = {};
    if (data.games && typeof data.games === 'object') {
      for (const [appid, raw] of Object.entries(data.games as Record<string, unknown>)) {
        const entry = /^[1-9]\d{0,9}$/.test(appid) ? toLibIndexEntry(raw) : null;
        if (entry) games[appid] = entry;
      }
    }
    return data.updatedAt instanceof Timestamp ? { games, updatedAt: data.updatedAt } : { games };
  },
};

export function toTimestamp(value: Date | number | string): Timestamp {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('Invalid time');
  return Timestamp.fromMillis(ms);
}

export function expiresIn(ms: number, now = Date.now()): Timestamp {
  return Timestamp.fromMillis(now + ms);
}

/** Readers check expiry themselves; Firestore TTL deletion is only housekeeping. A missing or malformed expiry counts as expired. */
export function isExpired(expiresAt: unknown, now = Date.now()): boolean {
  return !(expiresAt instanceof Timestamp) || expiresAt.toMillis() <= now;
}
