import type { DocumentReference, DocumentSnapshot, Transaction, WriteBatch } from 'firebase-admin/firestore';
import { db } from '../firestore';

/** Firestore allows 500 writes per batch; stay below it so a caller can add a trailing write. */
export const BATCH_WRITE_LIMIT = 450;
export const GET_ALL_LIMIT = 100;

/** Runs `fn` in a transaction. Firestore retries on contention, so `fn` must be side-effect free apart from `tx` writes. */
export function runTransaction<T>(fn: (tx: Transaction) => Promise<T>, maxAttempts = 5): Promise<T> {
  return db.runTransaction(fn, { maxAttempts });
}

/** Commits queued writes in batches. Each batch is atomic; the whole list is not. */
export async function commitInBatches(writes: Array<(batch: WriteBatch) => void>, size = BATCH_WRITE_LIMIT): Promise<void> {
  for (let offset = 0; offset < writes.length; offset += size) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + size)) write(batch);
    await batch.commit();
  }
}

/** Reads refs in `getAll` groups, preserving order. Every ref costs one read, missing or not. */
export async function getAllInGroups(refs: DocumentReference[], size = GET_ALL_LIMIT): Promise<DocumentSnapshot[]> {
  const snapshots: DocumentSnapshot[] = [];
  for (let offset = 0; offset < refs.length; offset += size) {
    snapshots.push(...await db.getAll(...refs.slice(offset, offset + size)));
  }
  return snapshots;
}
