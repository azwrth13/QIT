import { FieldPath, Timestamp, type DocumentData, type DocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { buildAchievementRecord, isFresh, type AchievementRecord } from '../achievements/model';
import {
  fetchAchievementRecord, isAchievementsPrivate, markAchievementsPrivate, readAchievementRecord, saveAchievementRecords,
} from '../achievements/store';
import { logServerError } from '../steam';
import { getPlayerAchievements, type PlayerAchievement } from '../steam/achievements';
import type { SteamClient } from '../steam/client';
import { readLibIndex } from '../store/lib-index';
import { stripUndefined } from '../store/converters';
import { appIdSegment, paths } from '../store/paths';
import { runTransaction } from '../store/tx';
import type { ChallengeKind, ChallengeRecord, ChallengeStatus, ChallengeUnlock } from '../store/types';
import { stageEvent } from './events';
import { decodeRollCursor, encodeRollCursor } from './rolls';

// The only writer of `users/{id}/challenges/{challengeId}`. A challenge is an explicit state machine
// (TRANSITIONS below); every transition runs in a Firestore transaction that re-reads the challenge, so a transition
// the current status forbids is rejected and two racing calls change it once. Each transition records its event in
// the same transaction (`challenge_issue`, `challenge_accept`, `challenge_decline`, `challenge_complete`,
// `challenge_expire`), which is how streaks and stats learn about completions; nothing here touches the summary.
//
// Verification never trusts the client: it re-fetches that one game's achievements from Steam and counts an
// achievement only when it is unlocked with an `unlocktime` at or after the acceptance time.

export const CHALLENGE_KINDS: readonly ChallengeKind[] = ['achievement', 'rare', 'any'];
export const CHALLENGE_STATUSES: readonly ChallengeStatus[] = ['issued', 'accepted', 'completed', 'declined', 'expired'];
/** Rare tiers (report section 2.4): global unlock percent below 25, 10 or 5. */
export const RARE_THRESHOLDS: readonly number[] = [25, 10, 5];

/** Every legal move. Anything else is rejected; `expired` is reached only once `expiresAt` has passed. */
export const TRANSITIONS: Readonly<Record<ChallengeStatus, readonly ChallengeStatus[]>> = Object.freeze({
  issued: ['accepted', 'declined', 'expired'],
  accepted: ['completed', 'expired'],
  completed: [],
  declined: [],
  expired: [],
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** How long an issued challenge waits to be accepted, then how long each kind has once accepted. */
export const CHALLENGE_TTL_MS = Object.freeze({
  offer: 3 * DAY,
  achievement: 7 * DAY,
  any: 7 * DAY,
  rare: 14 * DAY,
});

/** Issued plus accepted challenges a user may hold at once. */
export const MAX_ACTIVE_CHALLENGES = 20;
/** Most new unlocks an `any` challenge can ask for. */
export const MAX_CHALLENGE_COUNT = 50;
export const MAX_CHALLENGES_PAGE = 50;
/** Upper bound on the active challenges one expiry sweep reads (more than the cap, for overdue leftovers). */
const ACTIVE_READ_LIMIT = 200;
const MAX_APINAME_CHARS = 128;
const ACTIVE: readonly ChallengeStatus[] = ['issued', 'accepted'];

const EVENT_TYPES: Readonly<Record<ChallengeStatus, string>> = {
  issued: 'challenge_issue',
  accepted: 'challenge_accept',
  completed: 'challenge_complete',
  declined: 'challenge_decline',
  expired: 'challenge_expire',
};

export function canTransition(from: ChallengeStatus, to: ChallengeStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface ChallengeInput {
  kind: ChallengeKind;
  appid: number;
  /** Target achievement for `achievement` and `rare`. */
  apiname?: string;
  /** Rare tier for `rare`, one of RARE_THRESHOLDS. */
  threshold?: number;
  /** New unlocks needed for `any`; defaults to 1. */
  count?: number;
}

export interface ChallengeView {
  id: string;
  kind: ChallengeKind;
  appid: number;
  name: string | null;
  apiname: string | null;
  achievementName: string | null;
  achievementDescription: string | null;
  threshold: number | null;
  /** New unlocks needed: 1 for a single-achievement challenge. */
  count: number;
  status: ChallengeStatus;
  issuedAt: Date;
  acceptedAt: Date | null;
  completedAt: Date | null;
  declinedAt: Date | null;
  expiredAt: Date | null;
  expiresAt: Date;
  unlocks: ChallengeUnlock[];
}

/** Checks the shape of an issue request and returns a clean copy; throws when it is malformed. Pure. */
export function validateChallengeInput(input: ChallengeInput): ChallengeInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid challenge');
  if (!CHALLENGE_KINDS.includes(input.kind)) throw new Error('Invalid challenge kind');
  if (typeof input.appid !== 'number') throw new Error('Invalid app ID');
  const appid = Number(appIdSegment(input.appid));
  if (input.kind === 'any') {
    if (input.apiname !== undefined || input.threshold !== undefined) throw new Error('An any-achievement challenge has no target');
    const count = input.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CHALLENGE_COUNT) throw new Error('Invalid count');
    return { kind: 'any', appid, count };
  }
  if (typeof input.apiname !== 'string' || !input.apiname || input.apiname.length > MAX_APINAME_CHARS) throw new Error('Invalid achievement');
  if (input.count !== undefined) throw new Error('A single-achievement challenge has no count');
  if (input.kind === 'rare') {
    if (!RARE_THRESHOLDS.includes(input.threshold as number)) throw new Error('Invalid rare threshold');
    return { kind: 'rare', appid, apiname: input.apiname, threshold: input.threshold };
  }
  if (input.threshold !== undefined) throw new Error('Only a rare challenge has a threshold');
  return { kind: 'achievement', appid, apiname: input.apiname };
}

/**
 * The unlocks that count toward a challenge: unlocked, with an `unlocktime` at or after the acceptance second
 * (Steam reports whole seconds), and for a targeted challenge only its achievement. Earliest first. Pure.
 */
export function qualifyingUnlocks(
  challenge: Pick<ChallengeView, 'kind' | 'apiname'>, achievements: readonly PlayerAchievement[], acceptedAtMs: number,
): ChallengeUnlock[] {
  const since = Math.floor(acceptedAtMs / 1000);
  return achievements
    .filter(achievement => achievement.achieved && achievement.unlocktime !== null && achievement.unlocktime >= since
      && (challenge.kind === 'any' || achievement.apiname === challenge.apiname))
    .map(achievement => ({ apiname: achievement.apiname, unlocktime: achievement.unlocktime as number }))
    .sort((a, b) => a.unlocktime - b.unlocktime || (a.apiname < b.apiname ? -1 : a.apiname > b.apiname ? 1 : 0));
}

export interface ChallengeProgress {
  unlocked: number;
  required: number;
}

/** Whether `achievements` complete an accepted challenge, with the unlocks that do it. Pure. */
export function evaluateChallenge(
  challenge: Pick<ChallengeView, 'kind' | 'apiname' | 'count' | 'acceptedAt'>, achievements: readonly PlayerAchievement[],
): { met: boolean; progress: ChallengeProgress; unlocks: ChallengeUnlock[] } {
  const required = challenge.count;
  if (!challenge.acceptedAt) return { met: false, progress: { unlocked: 0, required }, unlocks: [] };
  const unlocks = qualifyingUnlocks(challenge, achievements, challenge.acceptedAt.getTime());
  return { met: unlocks.length >= required, progress: { unlocked: Math.min(unlocks.length, required), required }, unlocks: unlocks.slice(0, required) };
}

/** Active (issued or accepted) and past its expiry. */
export function isOverdue(challenge: Pick<ChallengeView, 'status' | 'expiresAt'>, now: number): boolean {
  return ACTIVE.includes(challenge.status) && challenge.expiresAt.getTime() <= now;
}

const date = (value: unknown) => value instanceof Timestamp ? value.toDate() : null;
const text = (value: unknown) => typeof value === 'string' ? value : null;

function readUnlocks(value: unknown): ChallengeUnlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => item && typeof item.apiname === 'string' && Number.isSafeInteger(item.unlocktime)
    ? [{ apiname: item.apiname, unlocktime: item.unlocktime }] : []);
}

/** Reads stored challenge data defensively: null when the essentials are missing or malformed. */
export function toChallengeView(id: string, data: DocumentData | undefined): ChallengeView | null {
  if (!data || !CHALLENGE_KINDS.includes(data.kind) || !CHALLENGE_STATUSES.includes(data.status) || typeof data.appid !== 'number'
    || !(data.issuedAt instanceof Timestamp) || !(data.expiresAt instanceof Timestamp)) return null;
  return {
    id,
    kind: data.kind,
    appid: data.appid,
    name: text(data.name),
    apiname: text(data.apiname),
    achievementName: text(data.achievementName),
    achievementDescription: text(data.achievementDescription),
    threshold: typeof data.threshold === 'number' ? data.threshold : null,
    count: data.kind === 'any' && Number.isSafeInteger(data.count) && data.count > 0 ? data.count : 1,
    status: data.status,
    issuedAt: data.issuedAt.toDate(),
    acceptedAt: date(data.acceptedAt),
    completedAt: date(data.completedAt),
    declinedAt: date(data.declinedAt),
    expiredAt: date(data.expiredAt),
    expiresAt: data.expiresAt.toDate(),
    unlocks: readUnlocks(data.unlocks),
  };
}

const viewOf = (snapshot: DocumentSnapshot) => toChallengeView(snapshot.id, snapshot.data());

const challengesRef = (steamId: string) => db.collection(paths.challenges(steamId));
const challengeRef = (steamId: string, id: string) => db.doc(paths.challenge(steamId, id));

export async function getChallenge(steamId: string, id: string): Promise<ChallengeView | null> {
  return viewOf(await challengeRef(steamId, id).get());
}

type Change = { fields: Record<string, Timestamp | ChallengeUnlock[]>; meta?: Record<string, unknown> };

const eventMeta = (challenge: ChallengeView, extra: Record<string, unknown> = {}) =>
  stripUndefined({ kind: challenge.kind, threshold: challenge.threshold ?? undefined, ...extra });

/** Stages one transition and its event in `tx`. Throws on an illegal move, so no code path can write one. */
function stageTransition(tx: Transaction, steamId: string, challenge: ChallengeView, to: ChallengeStatus, change: Change, now: number): ChallengeView {
  if (!canTransition(challenge.status, to)) throw new Error(`Illegal challenge transition ${challenge.status} -> ${to}`);
  tx.update(challengeRef(steamId, challenge.id), { status: to, ...change.fields });
  stageEvent(tx, steamId, { type: EVENT_TYPES[to], appid: challenge.appid, refId: challenge.id, meta: eventMeta(challenge, change.meta) }, now);
  const updated: ChallengeView = { ...challenge, status: to };
  for (const [key, value] of Object.entries(change.fields)) {
    (updated as unknown as Record<string, unknown>)[key] = value instanceof Timestamp ? value.toDate() : value;
  }
  return updated;
}

const expireChange = (challenge: ChallengeView, at: Timestamp): Change => ({ fields: { expiredAt: at }, meta: { from: challenge.status } });

export type ChallengeResult =
  | { outcome: 'updated' | 'unchanged' | 'conflict'; challenge: ChallengeView }
  | { outcome: 'not_found' };

/**
 * Moves a challenge to `to` in a transaction. An overdue challenge expires first, whatever was asked, and the asked
 * move then meets an expired challenge (a conflict, unless the move was the expiry). Repeating the current status is
 * `unchanged`; a move TRANSITIONS forbids is a `conflict`.
 */
function transition(steamId: string, id: string, to: ChallengeStatus, now: number, build: (challenge: ChallengeView, at: Timestamp) => Change): Promise<ChallengeResult> {
  return runTransaction(async tx => {
    const challenge = viewOf(await tx.get(challengeRef(steamId, id)));
    if (!challenge) return { outcome: 'not_found' as const };
    const at = Timestamp.fromMillis(now);
    if (isOverdue(challenge, now)) {
      const expired = stageTransition(tx, steamId, challenge, 'expired', expireChange(challenge, at), now);
      return { outcome: to === 'expired' ? 'updated' as const : 'conflict' as const, challenge: expired };
    }
    if (challenge.status === to) return { outcome: 'unchanged' as const, challenge };
    if (to === 'expired' || !canTransition(challenge.status, to)) return { outcome: 'conflict' as const, challenge };
    return { outcome: 'updated' as const, challenge: stageTransition(tx, steamId, challenge, to, build(challenge, at), now) };
  });
}

/** issued -> accepted. The attempt window starts now and its length depends on the kind. */
export function acceptChallenge(steamId: string, id: string, now = Date.now()): Promise<ChallengeResult> {
  return transition(steamId, id, 'accepted', now, (challenge, at) => ({
    fields: { acceptedAt: at, expiresAt: Timestamp.fromMillis(now + CHALLENGE_TTL_MS[challenge.kind]) },
  }));
}

/** issued -> declined. */
export function declineChallenge(steamId: string, id: string, now = Date.now()): Promise<ChallengeResult> {
  return transition(steamId, id, 'declined', now, (_, at) => ({ fields: { declinedAt: at } }));
}

/** issued | accepted -> expired, only once `expiresAt` has passed; earlier it is a conflict. */
export function expireChallenge(steamId: string, id: string, now = Date.now()): Promise<ChallengeResult> {
  return transition(steamId, id, 'expired', now, expireChange);
}

/** accepted -> completed with the unlocks that proved it. Only `verifyChallenge` calls this, after checking Steam. */
function completeChallenge(steamId: string, id: string, unlocks: ChallengeUnlock[], now: number): Promise<ChallengeResult> {
  return transition(steamId, id, 'completed', now, (_, at) => ({ fields: { completedAt: at, unlocks }, meta: { unlocks: unlocks.length } }));
}

export type VerifyResult =
  | ChallengeResult
  /** Accepted, but Steam does not show enough qualifying unlocks yet. */
  | { outcome: 'pending'; challenge: ChallengeView; progress: ChallengeProgress }
  /** Steam does not share the user's achievements (now, or within the achievements data's recheck window). */
  | { outcome: 'private'; challenge: ChallengeView };

/** A verify that met an overdue challenge: the expiry happened, but the verify itself is a conflict. */
function asVerify(result: ChallengeResult): VerifyResult {
  if (result.outcome === 'not_found') return result;
  return { outcome: result.challenge.status === 'completed' ? 'unchanged' : 'conflict', challenge: result.challenge };
}

export interface VerifyOptions {
  now?: number;
  client?: SteamClient;
}

/**
 * Checks an accepted challenge against Steam and completes it when the unlocks are there. Fetches only that game's
 * achievements, through the shared Steam client, and stores the answer as the game's achievement record too. Steam
 * failures throw the client's `SteamClientError`. Racing calls complete the challenge (and emit its event) once.
 */
export async function verifyChallenge(steamId: string, id: string, { now = Date.now(), client }: VerifyOptions = {}): Promise<VerifyResult> {
  const challenge = await getChallenge(steamId, id);
  if (!challenge) return { outcome: 'not_found' };
  if (challenge.status === 'completed') return { outcome: 'unchanged', challenge };
  if (isOverdue(challenge, now)) return asVerify(await expireChallenge(steamId, id, now));
  if (challenge.status !== 'accepted') return { outcome: 'conflict', challenge };
  if (await isAchievementsPrivate(steamId, now)) return { outcome: 'private', challenge };

  const result = await getPlayerAchievements(steamId, challenge.appid, 'english', client);
  if (result.state === 'private') {
    await markAchievementsPrivate(steamId, now);
    return { outcome: 'private', challenge };
  }
  // The fresh answer also refreshes the game's achievement data; a failed write only costs a refetch later.
  try {
    await saveAchievementRecords(steamId, new Map([[challenge.appid, buildAchievementRecord(result, now)]]));
  } catch (error) {
    logServerError('Challenge achievement refresh failed', error);
  }
  const evaluation = evaluateChallenge(challenge, result.state === 'ok' ? result.achievements : []);
  if (!evaluation.met) return { outcome: 'pending', challenge, progress: evaluation.progress };
  return completeChallenge(steamId, id, evaluation.unlocks, now);
}

export type IssueResult =
  /** `existing`: the same challenge is already active, so it is returned instead of a duplicate. */
  | { outcome: 'created' | 'existing'; challenge: ChallengeView }
  | { outcome: 'needs_sync' | 'not_owned' | 'private' | 'no_achievements' | 'not_locked' | 'limit' };

export interface IssueOptions {
  now?: number;
  client?: SteamClient;
}

/** The game's achievement record, fetched (and stored) when it is missing or stale; null when Steam keeps it private. */
async function currentAchievementRecord(steamId: string, appid: number, now: number, client?: SteamClient): Promise<AchievementRecord | 'private'> {
  const stored = await readAchievementRecord(steamId, appid);
  if (stored && isFresh(stored, now)) return stored;
  if (await isAchievementsPrivate(steamId, now)) return 'private';
  const record = await fetchAchievementRecord(steamId, appid, now, client);
  if (!record) {
    await markAchievementsPrivate(steamId, now);
    return 'private';
  }
  await saveAchievementRecords(steamId, new Map([[appid, record]]));
  return record;
}

const sameTarget = (a: Pick<ChallengeView, 'kind' | 'appid' | 'apiname'>, b: ChallengeInput) =>
  a.kind === b.kind && a.appid === b.appid && a.apiname === (b.apiname ?? null);

/**
 * Issues a challenge for an owned game. A targeted challenge needs its achievement to be locked right now, and an
 * `any` challenge needs at least `count` locked achievements, both read from the game's achievement data (fetched
 * from Steam when missing or stale). Throws on a malformed input and on Steam failures.
 */
export async function issueChallenge(steamId: string, raw: ChallengeInput, { now = Date.now(), client }: IssueOptions = {}): Promise<IssueResult> {
  const input = validateChallengeInput(raw);
  const index = await readLibIndex(steamId);
  if (!index.built) return { outcome: 'needs_sync' };
  const entry = index.entries.get(input.appid);
  if (!entry) return { outcome: 'not_owned' };

  const record = await currentAchievementRecord(steamId, input.appid, now, client);
  if (record === 'private') return { outcome: 'private' };
  if (record.state !== 'ok' || !record.progress) return { outcome: 'no_achievements' };
  const target = input.kind === 'any' ? null : record.locked.find(achievement => achievement.apiname === input.apiname);
  if (input.kind === 'any' ? record.progress.total - record.progress.unlocked < (input.count ?? 1) : !target) return { outcome: 'not_locked' };

  const ref = challengesRef(steamId).doc();
  const issued: ChallengeRecord = stripUndefined({
    kind: input.kind,
    appid: input.appid,
    name: entry.n,
    apiname: input.apiname,
    achievementName: target?.name,
    achievementDescription: target?.description,
    threshold: input.threshold,
    count: input.count,
    status: 'issued' as const,
    issuedAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(now + CHALLENGE_TTL_MS.offer),
  });
  return runTransaction(async tx => {
    // Reading the active set in the transaction makes the duplicate check and the cap race-free.
    const active = (await tx.get(challengesRef(steamId).where('status', 'in', ACTIVE).limit(ACTIVE_READ_LIMIT))).docs
      .map(viewOf)
      .filter((challenge): challenge is ChallengeView => !!challenge && !isOverdue(challenge, now));
    const duplicate = active.find(challenge => sameTarget(challenge, input));
    if (duplicate) return { outcome: 'existing' as const, challenge: duplicate };
    if (active.length >= MAX_ACTIVE_CHALLENGES) return { outcome: 'limit' as const };
    tx.create(ref, issued);
    stageEvent(tx, steamId, { type: EVENT_TYPES.issued, appid: input.appid, refId: ref.id, meta: stripUndefined({ kind: input.kind, threshold: input.threshold }) }, now);
    return { outcome: 'created' as const, challenge: toChallengeView(ref.id, issued)! };
  });
}

/** Expires every active challenge whose time has passed. Returns the expired ids. */
export async function expireOverdueChallenges(steamId: string, now = Date.now()): Promise<string[]> {
  const snapshot = await challengesRef(steamId).where('status', 'in', ACTIVE).limit(ACTIVE_READ_LIMIT).get();
  const overdue = snapshot.docs.map(viewOf).filter((challenge): challenge is ChallengeView => !!challenge && isOverdue(challenge, now));
  const results = await Promise.all(overdue.map(challenge => expireChallenge(steamId, challenge.id, now)));
  return overdue.filter((_, i) => results[i].outcome === 'updated').map(challenge => challenge.id);
}

export interface ListOptions {
  /** `active`: issued and accepted, newest first, unpaged (at most MAX_ACTIVE_CHALLENGES). `all`: every status, paged. */
  status?: 'active' | 'all';
  limit?: number;
  cursor?: string;
  now?: number;
}

export const encodeChallengeCursor = (challenge: { id: string; issuedAt: Timestamp }) => encodeRollCursor({ id: challenge.id, at: challenge.issuedAt });
export const decodeChallengeCursor = decodeRollCursor;

/** The user's challenges, newest first. Overdue ones are expired first, so every listed status is current. */
export async function listChallenges(steamId: string, { status = 'all', limit = 20, cursor, now = Date.now() }: ListOptions = {}): Promise<{ challenges: ChallengeView[]; nextCursor: string | null }> {
  const after = cursor === undefined ? null : decodeChallengeCursor(cursor);
  if (cursor !== undefined && !after) throw new Error('Invalid cursor');
  if (status === 'active' && cursor !== undefined) throw new Error('Active challenges are not paged');
  await expireOverdueChallenges(steamId, now);
  if (status === 'active') {
    const snapshot = await challengesRef(steamId).where('status', 'in', ACTIVE).limit(ACTIVE_READ_LIMIT).get();
    const challenges = snapshot.docs.map(viewOf).filter((challenge): challenge is ChallengeView => !!challenge)
      .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime() || (a.id < b.id ? 1 : -1));
    return { challenges, nextCursor: null };
  }
  const size = Math.max(1, Math.min(Math.floor(limit) || 20, MAX_CHALLENGES_PAGE));
  let query = challengesRef(steamId).orderBy('issuedAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
  if (after) query = query.startAfter(after.at, after.id);
  const snapshot = await query.limit(size).get();
  const challenges = snapshot.docs.map(viewOf).filter((challenge): challenge is ChallengeView => !!challenge);
  const last = snapshot.docs.at(-1);
  const lastAt = last?.get('issuedAt');
  const nextCursor = snapshot.size === size && last && lastAt instanceof Timestamp ? encodeChallengeCursor({ id: last.id, issuedAt: lastAt }) : null;
  return { challenges, nextCursor };
}
