import { DocumentReference, FieldValue, GeoPoint, Timestamp } from 'firebase-admin/firestore';

// Firestore per-document limits (https://firebase.google.com/docs/firestore/quotas) and the documented
// storage size rules (https://firebase.google.com/docs/firestore/storage-size), used to check chunked
// documents such as the library index before they get near a limit.

export const MAX_DOCUMENT_BYTES = 1_048_576;
export const MAX_INDEX_ENTRIES = 40_000;

const stringSize = (value: string) => Buffer.byteLength(value, 'utf8') + 1;

/** Document name size: each collection and document id in the path, plus 16. */
export function documentNameSize(path: string): number {
  return path.split('/').reduce((sum, segment) => sum + stringSize(segment), 16);
}

export function valueSize(value: unknown): number {
  if (value === null || typeof value === 'boolean') return 1;
  if (typeof value === 'number' || value instanceof Timestamp || value instanceof Date) return 8;
  if (typeof value === 'string') return stringSize(value);
  if (value instanceof GeoPoint) return 16;
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof DocumentReference) return documentNameSize(value.path);
  if (value instanceof FieldValue) return 8;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + valueSize(item), 0);
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .reduce((sum, [key, item]) => item === undefined ? sum : sum + stringSize(key) + valueSize(item), 0);
  }
  return 0;
}

/** Stored size of a document at `path` with `data`, per Firestore's storage size rules. */
export function documentSize(path: string, data: Record<string, unknown>): number {
  return documentNameSize(path) + valueSize(data) + 32;
}

/**
 * Estimated automatic single-field index entries for `data`: two (ascending and descending) for every field and
 * subfield at any depth, plus one array-contains entry per distinct array element. Fields listed in `exempt`
 * (dot paths) contribute nothing, and neither do their subfields, which inherit a map field's exemption.
 */
export function estimateIndexEntries(data: Record<string, unknown>, exempt: string[] = []): number {
  const skip = new Set(exempt);
  const count = (value: unknown, path: string): number => {
    if (skip.has(path) || value === undefined) return 0;
    let entries = 2;
    if (Array.isArray(value)) entries += new Set(value.map(item => JSON.stringify(item))).size;
    else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) entries += count(item, `${path}.${key}`);
    }
    return entries;
  };
  return Object.entries(data).reduce((sum, [key, value]) => sum + count(value, key), 0);
}
