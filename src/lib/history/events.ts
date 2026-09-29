import { Timestamp, type QueryDocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { appIdSegment, docIdSegment, paths } from '../store/paths';
import { stripUndefined } from '../store/converters';
import { runTransaction } from '../store/tx';
import type { EventRecord } from '../store/types';
import { applyEventToStats } from './stats';

// The only writer of `users/{id}/events/{eventId}` (append-only). Every event also moves the stats counters
// (`stats.ts`) in the same transaction, so other packages record events here and never touch the summary.
//
// Types written by this package: roll, accept, reroll, played, exclude, unexclude. Other packages add their
// own types (for example daily or challenge events) without changing this module.

const EVENT_TYPE = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_EVENT_META_BYTES = 2048;

export interface EventInput {
  type: string;
  appid?: number;
  /** Id of the record the event is about, for example a roll id. */
  refId?: string;
  /** Small JSON-safe details; at most 2 KiB serialized. */
  meta?: Record<string, unknown>;
}

export interface EventView {
  id: string;
  type: string;
  at: Date;
  appid: number | null;
  refId: string | null;
  meta: Record<string, unknown>;
}

/** Throws when the event is malformed. Pure; exported for tests. */
export function validateEvent(event: EventInput): void {
  if (!EVENT_TYPE.test(event.type)) throw new Error('Invalid event type');
  if (event.appid !== undefined) appIdSegment(event.appid);
  if (event.refId !== undefined) docIdSegment(event.refId);
  if (event.meta !== undefined) {
    if (!event.meta || typeof event.meta !== 'object' || Object.getPrototypeOf(event.meta) !== Object.prototype) {
      throw new Error('Invalid event meta');
    }
    const json = JSON.stringify(event.meta);
    if (Buffer.byteLength(json, 'utf8') > MAX_EVENT_META_BYTES) throw new Error('Event meta too large');
  }
}

/**
 * Stages an event and its counter increments in `tx` and returns the new event id. Use this from a transaction
 * that also changes the record the event describes; otherwise call `recordEvent`.
 */
export function stageEvent(tx: Transaction, steamId: string, event: EventInput, now = Date.now()): string {
  validateEvent(event);
  const ref = db.collection(paths.events(steamId)).doc();
  const at = Timestamp.fromMillis(now);
  const record: EventRecord = stripUndefined({
    type: event.type,
    at,
    appid: event.appid,
    refId: event.refId,
    // Round-trips through JSON so only plain data is stored.
    meta: event.meta === undefined ? undefined : JSON.parse(JSON.stringify(event.meta)) as Record<string, unknown>,
  });
  tx.create(ref, record);
  applyEventToStats(tx, steamId, event, at);
  return ref.id;
}

/** Appends one event and updates the stats counters atomically. Returns the event id. */
export async function recordEvent(steamId: string, event: EventInput, now = Date.now()): Promise<string> {
  validateEvent(event);
  return runTransaction(async tx => stageEvent(tx, steamId, event, now));
}

function toEventView(snapshot: QueryDocumentSnapshot): EventView | null {
  const data = snapshot.data();
  if (typeof data.type !== 'string' || !(data.at instanceof Timestamp)) return null;
  return {
    id: snapshot.id,
    type: data.type,
    at: data.at.toDate(),
    appid: typeof data.appid === 'number' ? data.appid : null,
    refId: typeof data.refId === 'string' ? data.refId : null,
    meta: data.meta && typeof data.meta === 'object' ? data.meta as Record<string, unknown> : {},
  };
}

/**
 * Newest first. With `type`, filters by type without a Firestore order (no composite index) and sorts the page in
 * memory, so `limit` then bounds the reads, not the recency: it returns at most `limit` events of that type.
 */
export async function listEvents(steamId: string, { type, limit = 100 }: { type?: string; limit?: number } = {}): Promise<EventView[]> {
  if (type !== undefined && !EVENT_TYPE.test(type)) throw new Error('Invalid event type');
  const collection = db.collection(paths.events(steamId));
  const query = type === undefined ? collection.orderBy('at', 'desc') : collection.where('type', '==', type);
  const snapshot = await query.limit(Math.max(1, Math.min(limit, 500))).get();
  return snapshot.docs.map(toEventView).filter((event): event is EventView => !!event)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}
