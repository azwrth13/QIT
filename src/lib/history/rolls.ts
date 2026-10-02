import { FieldPath, Timestamp, type DocumentSnapshot } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { MODE_IDS, SCOPE_KINDS, type FilterSelection, type ModeId, type Reason, type Scope } from '../roulette/types';
import { THRESHOLDS } from '../roulette/thresholds';
import { isSteamId } from '../steam';
import { stripUndefined } from '../store/converters';
import { appIdSegment, docIdSegment, paths } from '../store/paths';
import { runTransaction } from '../store/tx';
import type { RollRecord, RollStatus } from '../store/types';
import { stageEvent } from './events';

// The only writer of `users/{id}/rolls/{rollId}`. Every change records its event (and so its stats counters) in
// the same transaction. Status is the user's decision on the roll (rolled -> accepted | rerolled); played is
// tracked separately because a game can be played whatever was decided on the card.

export const MAX_ROLL_REASONS = 10;
export const MAX_ROLL_FILTERS = 20;
export const MAX_ROLL_PARTICIPANTS = 32;
export const MAX_ROLLS_PAGE = 50;
/** Upper bound on the rolls read by `recentlyRolled`. */
export const RECENT_ROLLS_LIMIT = 500;
/** Sync detection considers only this recent window, capped before filtering played rolls. */
export const PLAYED_DETECTION_WINDOW_DAYS = 30;
export const PLAYED_DETECTION_ROLL_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RollInput {
  appid: number;
  name?: string;
  modeId: ModeId;
  filters: FilterSelection[];
  scope: Scope;
  /** Everyone in the scope, requester first; defaults to the requester alone. */
  participants?: string[];
  lobbyId?: string;
  /** Minutes at roll time; null when unknown (playtime hidden). Played detection compares against it. */
  playtimeAtRoll: number | null;
  reasons: Reason[];
}

export interface RollView {
  id: string;
  appid: number;
  name: string | null;
  modeId: string;
  filters: FilterSelection[];
  scope: Scope | null;
  participants: string[];
  lobbyId: string | null;
  at: Date;
  status: RollStatus;
  acceptedAt: Date | null;
  rerolledAt: Date | null;
  playedAt: Date | null;
  playedSource: 'sync' | 'manual' | null;
  playtimeAtRoll: number | null;
  reasons: Reason[];
}

export type TransitionResult =
  | { outcome: 'updated' | 'unchanged'; roll: RollView }
  | { outcome: 'conflict'; roll: RollView }
  | { outcome: 'not_found' };

const rollsRef = (steamId: string) => db.collection(paths.rolls(steamId));
const rollRef = (steamId: string, rollId: string) => db.doc(paths.roll(steamId, rollId));

function validScope(scope: unknown): scope is Scope {
  if (!scope || typeof scope !== 'object') return false;
  const value = scope as Record<string, unknown>;
  if (!SCOPE_KINDS.includes(value.kind as Scope['kind'])) return false;
  switch (value.kind) {
    case 'friends': return Array.isArray(value.with) && value.with.length <= MAX_ROLL_PARTICIPANTS && value.with.every(isSteamId);
    case 'pair': return isSteamId(value.with);
    case 'lobby': return typeof value.code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value.code);
    case 'appids': return Array.isArray(value.appids) && value.appids.length <= 500 && value.appids.every(id => Number.isSafeInteger(id) && id > 0);
    default: return true;
  }
}

/** Builds the stored record, throwing on malformed input. Pure; exported for tests. */
export function buildRollRecord(steamId: string, input: RollInput, now: number): RollRecord {
  const participants = input.participants ?? [steamId];
  if (!MODE_IDS.includes(input.modeId)) throw new Error('Invalid mode');
  if (!validScope(input.scope)) throw new Error('Invalid scope');
  if (!Array.isArray(input.filters) || input.filters.length > MAX_ROLL_FILTERS || !input.filters.every(f => f && typeof f.id === 'string')) {
    throw new Error('Invalid filters');
  }
  if (!participants.length || participants.length > MAX_ROLL_PARTICIPANTS || !participants.every(isSteamId)) throw new Error('Invalid participants');
  if (!Array.isArray(input.reasons) || input.reasons.length > MAX_ROLL_REASONS) throw new Error('Invalid reasons');
  if (input.playtimeAtRoll !== null && !(Number.isFinite(input.playtimeAtRoll) && input.playtimeAtRoll >= 0)) throw new Error('Invalid playtime');
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 256)) throw new Error('Invalid name');
  // Filters, scope and reasons are stored as plain JSON so a caller's class instances or undefined values never reach Firestore.
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return stripUndefined({
    appid: Number(appIdSegment(input.appid)),
    name: input.name,
    modeId: input.modeId,
    filters: plain(input.filters),
    scope: plain(input.scope),
    participants: [...participants],
    lobbyId: input.lobbyId === undefined ? undefined : docIdSegment(input.lobbyId),
    at: Timestamp.fromMillis(now),
    status: 'rolled' as const,
    playtimeAtRoll: input.playtimeAtRoll,
    reasons: plain(input.reasons),
  });
}

const date = (value: unknown) => value instanceof Timestamp ? value.toDate() : null;

/** Reads a stored roll defensively: returns null when the essentials are missing. */
export function toRollView(snapshot: DocumentSnapshot): RollView | null {
  const data = snapshot.data();
  if (!data || typeof data.appid !== 'number' || !(data.at instanceof Timestamp)) return null;
  const status: RollStatus = data.status === 'accepted' || data.status === 'rerolled' ? data.status : 'rolled';
  return {
    id: snapshot.id,
    appid: data.appid,
    name: typeof data.name === 'string' ? data.name : null,
    modeId: typeof data.modeId === 'string' ? data.modeId : 'pure-random',
    filters: Array.isArray(data.filters) ? data.filters : [],
    scope: validScope(data.scope) ? data.scope : null,
    participants: Array.isArray(data.participants) ? data.participants.filter(isSteamId) : [],
    lobbyId: typeof data.lobbyId === 'string' ? data.lobbyId : null,
    at: data.at.toDate(),
    status,
    acceptedAt: date(data.acceptedAt),
    rerolledAt: date(data.rerolledAt),
    playedAt: date(data.playedAt),
    playedSource: data.playedSource === 'sync' || data.playedSource === 'manual' ? data.playedSource : null,
    playtimeAtRoll: typeof data.playtimeAtRoll === 'number' ? data.playtimeAtRoll : null,
    reasons: Array.isArray(data.reasons) ? data.reasons : [],
  };
}

/** Stores a new roll (status `rolled`) with its `roll` event. Returns the roll id. */
export async function recordRoll(steamId: string, input: RollInput, now = Date.now()): Promise<string> {
  const record = buildRollRecord(steamId, input, now);
  const ref = rollsRef(steamId).doc();
  await runTransaction(async tx => {
    tx.create(ref, record);
    stageEvent(tx, steamId, { type: 'roll', appid: record.appid, refId: ref.id, meta: { modeId: record.modeId, scope: record.scope.kind } }, now);
  });
  return ref.id;
}

export async function getRoll(steamId: string, rollId: string): Promise<RollView | null> {
  return toRollView(await rollRef(steamId, rollId).get());
}

type Change = { fields: { [field: string]: string | Timestamp }; event: { type: string; meta?: Record<string, unknown> } } | 'unchanged' | 'conflict';

async function transition(steamId: string, rollId: string, now: number, decide: (roll: RollView, at: Timestamp) => Change): Promise<TransitionResult> {
  const ref = rollRef(steamId, rollId);
  return runTransaction(async tx => {
    const roll = toRollView(await tx.get(ref));
    if (!roll) return { outcome: 'not_found' as const };
    const at = Timestamp.fromMillis(now);
    const change = decide(roll, at);
    if (change === 'unchanged' || change === 'conflict') return { outcome: change, roll };
    tx.update(ref, change.fields);
    stageEvent(tx, steamId, { type: change.event.type, appid: roll.appid, refId: roll.id, meta: change.event.meta }, now);
    const updated = { ...roll };
    for (const [key, value] of Object.entries(change.fields)) (updated as Record<string, unknown>)[key] = value instanceof Timestamp ? value.toDate() : value;
    return { outcome: 'updated' as const, roll: updated };
  });
}

/** rolled -> accepted. Accepting twice is a no-op; a rerolled roll cannot be accepted. */
export function markAccepted(steamId: string, rollId: string, now = Date.now()): Promise<TransitionResult> {
  return transition(steamId, rollId, now, (roll, at) => {
    if (roll.status === 'accepted') return 'unchanged';
    if (roll.status !== 'rolled') return 'conflict';
    return { fields: { status: 'accepted', acceptedAt: at }, event: { type: 'accept', meta: { modeId: roll.modeId } } };
  });
}

/** rolled -> rerolled. Rerolling twice is a no-op; an accepted roll cannot be rerolled. */
export function markRerolled(steamId: string, rollId: string, now = Date.now()): Promise<TransitionResult> {
  return transition(steamId, rollId, now, (roll, at) => {
    if (roll.status === 'rerolled') return 'unchanged';
    if (roll.status !== 'rolled') return 'conflict';
    return { fields: { status: 'rerolled', rerolledAt: at }, event: { type: 'reroll', meta: { modeId: roll.modeId } } };
  });
}

/** Records that the rolled game was played, whatever the roll's status. The first mark wins; later ones are no-ops. */
export async function markPlayed(steamId: string, rollId: string, source: 'sync' | 'manual', now = Date.now()): Promise<TransitionResult> {
  if (source !== 'sync' && source !== 'manual') throw new Error('Invalid played source');
  return transition(steamId, rollId, now, (roll, at) => {
    if (roll.playedAt) return 'unchanged';
    return { fields: { playedAt: at, playedSource: source }, event: { type: 'played', meta: { source } } };
  });
}

/**
 * Bounded sync work: one range query on `at`, newest first, with no composite index. Played rolls are included so
 * detection can stop at them. A transaction in `markPlayed` rechecks any concurrent mark.
 */
export async function recentRolls(steamId: string, now = Date.now()): Promise<RollView[]> {
  const since = Timestamp.fromMillis(now - PLAYED_DETECTION_WINDOW_DAYS * DAY_MS);
  const snapshot = await rollsRef(steamId).where('at', '>=', since).where('at', '<=', Timestamp.fromMillis(now))
    .orderBy('at', 'desc').limit(PLAYED_DETECTION_ROLL_LIMIT).get();
  return snapshot.docs.map(toRollView).filter((roll): roll is RollView => !!roll);
}

export interface RecentRoll {
  count: number;
  /** Unix seconds, matching `HistorySignals.lastRolledAt`. */
  lastRolledAt: number;
}

/**
 * Games rolled for the user in the last `days` days (every roll shown, whatever was decided), for the anti-repeat
 * filter. `days` 0 means the filter is off. One range query on `at`, at most RECENT_ROLLS_LIMIT reads.
 */
export async function recentlyRolled(steamId: string, { days = THRESHOLDS.antiRepeatDays, now = Date.now() } = {}): Promise<Map<number, RecentRoll>> {
  const recent = new Map<number, RecentRoll>();
  if (!(days > 0)) return recent;
  const since = Timestamp.fromMillis(now - days * DAY_MS);
  const snapshot = await rollsRef(steamId).where('at', '>=', since).orderBy('at', 'desc').limit(RECENT_ROLLS_LIMIT).get();
  for (const doc of snapshot.docs) {
    const roll = toRollView(doc);
    if (!roll) continue;
    const seconds = Math.floor(roll.at.getTime() / 1000);
    const entry = recent.get(roll.appid);
    if (entry) { entry.count++; entry.lastRolledAt = Math.max(entry.lastRolledAt, seconds); } else recent.set(roll.appid, { count: 1, lastRolledAt: seconds });
  }
  return recent;
}

// Page cursors carry the full timestamp and the id, so rolls sharing a millisecond are neither skipped nor repeated.
export function encodeRollCursor(roll: Pick<RollView, 'id'> & { at: Timestamp }): string {
  return `${roll.at.seconds}.${roll.at.nanoseconds}.${roll.id}`;
}

const MAX_TIMESTAMP_SECONDS = 253_402_300_799;

export function decodeRollCursor(cursor: string): { at: Timestamp; id: string } | null {
  const match = /^(\d{1,12})\.(\d{1,9})\.([A-Za-z0-9_-]{1,128})$/.exec(cursor);
  if (!match) return null;
  const seconds = Number(match[1]);
  const nanos = Number(match[2]);
  return seconds <= MAX_TIMESTAMP_SECONDS && nanos < 1e9 ? { at: new Timestamp(seconds, nanos), id: match[3] } : null;
}

/** Newest first. Orders by `at` then document id, which a single-field index serves (no composite index). */
export async function listRolls(steamId: string, { limit = 20, cursor }: { limit?: number; cursor?: string } = {}): Promise<{ rolls: RollView[]; nextCursor: string | null }> {
  const size = Math.max(1, Math.min(Math.floor(limit) || 20, MAX_ROLLS_PAGE));
  let query = rollsRef(steamId).orderBy('at', 'desc').orderBy(FieldPath.documentId(), 'desc');
  if (cursor !== undefined) {
    const after = decodeRollCursor(cursor);
    if (!after) throw new Error('Invalid cursor');
    query = query.startAfter(after.at, after.id);
  }
  const snapshot = await query.limit(size).get();
  const rolls = snapshot.docs.map(toRollView).filter((roll): roll is RollView => !!roll);
  const last = snapshot.docs.at(-1);
  const lastAt = last?.get('at');
  const nextCursor = snapshot.size === size && last && lastAt instanceof Timestamp ? encodeRollCursor({ id: last.id, at: lastAt }) : null;
  return { rolls, nextCursor };
}
