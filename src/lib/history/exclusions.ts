import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { appIdSegment, paths } from '../store/paths';
import { runTransaction } from '../store/tx';
import type { ExclusionScope, ExclusionsRecord } from '../store/types';
import { stageEvent } from './events';
import { endOfLocalDay } from './time';

// The only writer of `users/{id}/prefs/exclusions`: one map doc keyed by appid, so the spin pipeline reads every
// exclusion in one read. Scopes (captain decision D8): `session` until the picker or lobby session ends, `day`
// ("Not tonight") until the end of the user's local day, `7d`, and `forever` (until un-hidden). Readers check
// expiry themselves; every write also prunes expired entries, which keeps the doc small.

export const EXCLUSION_SCOPES: readonly ExclusionScope[] = ['session', 'day', '7d', 'forever'];
/**
 * Active entries per user. Every map subfield of this doc is indexed (about ten index entries per game), so the cap
 * keeps it far below Firestore's 40,000 index entries and 1 MiB per document.
 */
export const MAX_EXCLUSIONS = 1000;
/** Legacy session timeout; new session hides end explicitly, or stop applying when the session id changes. */
export const SESSION_EXCLUSION_MS = 12 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class ExclusionLimitError extends Error {
  constructor() {
    super(`At most ${MAX_EXCLUSIONS} games can be excluded`);
    this.name = 'ExclusionLimitError';
  }
}

export interface Exclusion {
  appid: number;
  scope: ExclusionScope;
  /** null for session and permanent hides. */
  until: Date | null;
  sessionId: string | null;
  at: Date;
}

type Entry = ExclusionsRecord[string];

function toEntry(raw: unknown): Entry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!EXCLUSION_SCOPES.includes(value.scope as ExclusionScope) || !(value.at instanceof Timestamp)) return null;
  if ((value.scope === 'day' || value.scope === '7d') && !(value.until instanceof Timestamp)) return null;
  if (value.scope === 'session' && typeof value.sessionId !== 'string') return null;
  const entry: Entry = { scope: value.scope as ExclusionScope, at: value.at };
  if (value.until instanceof Timestamp) entry.until = value.until;
  if (typeof value.sessionId === 'string') entry.sessionId = value.sessionId;
  return entry;
}

const isLive = (entry: Entry, now: number) => entry.scope === 'forever' || (entry.scope === 'session' && !entry.until) || (!!entry.until && entry.until.toMillis() > now);

/** Keeps well-formed, unexpired entries with valid appid keys. Pure; exported for tests. */
export function liveEntries(data: Record<string, unknown> | undefined, now: number): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const [appid, raw] of Object.entries(data ?? {})) {
    const entry = /^[1-9]\d{0,9}$/.test(appid) ? toEntry(raw) : null;
    if (entry && isLive(entry, now)) entries.set(appid, entry);
  }
  return entries;
}

/** When an exclusion made at `now` ends; null for session and permanent hides. `tz` is the user's IANA zone (UTC when missing). Pure. */
export function exclusionUntil(scope: ExclusionScope, now: number, tz?: string): number | null {
  switch (scope) {
    case 'session': return null;
    case 'day': return endOfLocalDay(now, tz);
    case '7d': return now + SEVEN_DAYS_MS;
    case 'forever': return null;
    default: throw new Error('Invalid exclusion scope');
  }
}

const toExclusion = (appid: string, entry: Entry): Exclusion => ({
  appid: Number(appid),
  scope: entry.scope,
  until: entry.until?.toDate() ?? null,
  sessionId: entry.sessionId ?? null,
  at: entry.at.toDate(),
});

const exclusionsRef = (steamId: string) => db.doc(paths.exclusions(steamId));

/**
 * Excludes a game. A new exclusion replaces an earlier one for the same game (the latest choice wins), except that a
 * `forever` exclusion is only lifted by `removeExclusion`: excluding a hidden game again returns the existing entry
 * and writes nothing. `session` needs a `sessionId`; `day` ends at the user's local midnight in `tz`.
 */
export async function addExclusion(
  steamId: string, appid: number, scope: ExclusionScope,
  { sessionId, tz, now = Date.now() }: { sessionId?: string; tz?: string; now?: number } = {},
): Promise<Exclusion> {
  const key = appIdSegment(appid);
  if (!EXCLUSION_SCOPES.includes(scope)) throw new Error('Invalid exclusion scope');
  if (scope === 'session' ? !SESSION_ID.test(sessionId ?? '') : sessionId !== undefined) throw new Error('Invalid session ID');
  const until = exclusionUntil(scope, now, tz);
  const entry: Entry = { scope, at: Timestamp.fromMillis(now) };
  if (until !== null && scope !== 'session') entry.until = Timestamp.fromMillis(until);
  if (sessionId !== undefined) entry.sessionId = sessionId;
  const ref = exclusionsRef(steamId);
  const stored = await runTransaction(async tx => {
    const entries = liveEntries((await tx.get(ref)).data(), now);
    const existing = entries.get(key);
    if (existing?.scope === 'forever' || (existing?.scope === scope && existing.sessionId === sessionId)) return existing;
    entries.delete(key);
    if (entries.size >= MAX_EXCLUSIONS) throw new ExclusionLimitError();
    entries.set(key, entry);
    // A full rewrite (not a merge) so a replaced entry keeps no stale fields and expired entries disappear.
    tx.set(ref, Object.fromEntries(entries));
    stageEvent(tx, steamId, { type: 'exclude', appid: Number(key), meta: { scope } }, now);
    return entry;
  });
  return toExclusion(key, stored);
}

/** Un-hides a game, whatever its scope. Returns false when it was not excluded (then nothing is written). */
export async function removeExclusion(steamId: string, appid: number, now = Date.now()): Promise<boolean> {
  const key = appIdSegment(appid);
  const ref = exclusionsRef(steamId);
  return runTransaction(async tx => {
    const entries = liveEntries((await tx.get(ref)).data(), now);
    if (!entries.delete(key)) return false;
    tx.set(ref, Object.fromEntries(entries));
    stageEvent(tx, steamId, { type: 'unexclude', appid: Number(key) }, now);
    return true;
  });
}

/**
 * The user's active exclusions in one read. `session` entries count only for the matching `sessionId`; without
 * one, no session entries are returned.
 */
export async function readExclusions(steamId: string, { sessionId, now = Date.now() }: { sessionId?: string; now?: number } = {}): Promise<Map<number, Exclusion>> {
  const entries = liveEntries((await exclusionsRef(steamId).get()).data(), now);
  const active = new Map<number, Exclusion>();
  for (const [appid, entry] of entries) {
    if (entry.scope === 'session' && (sessionId === undefined || entry.sessionId !== sessionId)) continue;
    active.set(Number(appid), toExclusion(appid, entry));
  }
  return active;
}

/** Management view includes session entries, even when another picker session is current. */
export async function listExclusions(steamId: string, now = Date.now()): Promise<Exclusion[]> {
  return [...liveEntries((await exclusionsRef(steamId).get()).data(), now)]
    .map(([appid, entry]) => toExclusion(appid, entry));
}

/** Ends only this user's picker/lobby session hides. Safe to repeat. */
export async function endExclusionSession(steamId: string, sessionId: string, now = Date.now()): Promise<number> {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid session ID');
  const ref = exclusionsRef(steamId);
  return runTransaction(async tx => {
    const entries = liveEntries((await tx.get(ref)).data(), now);
    let removed = 0;
    for (const [appid, entry] of entries) {
      if (entry.scope !== 'session' || entry.sessionId !== sessionId) continue;
      entries.delete(appid);
      removed++;
      stageEvent(tx, steamId, { type: 'unexclude', appid: Number(appid), meta: { sessionId } }, now);
    }
    if (removed) tx.set(ref, Object.fromEntries(entries));
    return removed;
  });
}
