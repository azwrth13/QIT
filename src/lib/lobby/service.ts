import { createHash, randomInt } from 'node:crypto';
import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { intersect } from '../group';
import { detectPlaytimeHidden, fromIndexEntry } from '../library/model';
import { applyPool, parseFilterSelections } from '../roulette/filter-engine';
import { candidateFromIndexEntry } from '../roulette/scopes/library';
import { THRESHOLDS } from '../roulette/thresholds';
import type { Candidate, FilterSelection } from '../roulette/types';
import { getLibraryFor, type FriendLibrary } from '../social/libraries';
import { firestoreSocialStore } from '../social/store';
import { paths, steamIdSegment } from '../store/paths';
import { runTransaction } from '../store/tx';
import type { LobbyMemberRecord, LobbyRecord } from '../store/types';
import { CODE_ALPHABET, IDLE_TTL_MS, LobbyError, lobbyView, MAX_MEMBERS, parseLobbyCode } from './model';
import { decodeCommonChunk, encodeCommon } from './common-cache';

export interface LobbyDeps {
  now?: () => number;
  libraries?: typeof getLibraryFor;
  generateCode?: () => string;
}

export function generateLobbyCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

function requireCode(raw: string): string {
  const code = parseLobbyCode(raw);
  if (!code) throw new LobbyError('invalid', 'Enter a six-character lobby code.', 400);
  return code;
}

/** Persistent token buckets apply across cold starts and all server instances. */
export async function takeLobbyLimit(kind: 'create' | 'join', identity: string, now = Date.now()): Promise<void> {
  const capacity = kind === 'create' ? 3 : 20;
  const windowMs = kind === 'create' ? 60 * 60 * 1000 : 60 * 1000;
  const key = `${kind}-${createHash('sha256').update(identity).digest('hex')}`;
  const ref = db.doc(paths.lobbyLimit(key));
  const wait = await runTransaction(async tx => {
    const record = (await tx.get(ref)).data();
    const tokens = record ? Math.min(capacity, record.tokens + Math.max(0, now - record.updatedAt.toMillis()) * capacity / windowMs) : capacity;
    if (tokens < 1) return Math.ceil((1 - tokens) * windowMs / capacity / 1000);
    tx.set(ref, { tokens: tokens - 1, updatedAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(now + windowMs) });
    return 0;
  });
  if (wait) throw new LobbyError('rate_limited', 'Too many lobby requests. Please try again later.', 429, wait);
}

function expire(tx: Transaction, code: string, lobby: LobbyRecord, now: number): boolean {
  if (lobby.status === 'active' && lobby.expiresAt.toMillis() <= now) {
    lobby.status = 'expired';
    lobby.version++;
    lobby.updatedAt = Timestamp.fromMillis(now);
    tx.set(db.doc(paths.lobby(code)), lobby);
  }
  return lobby.status !== 'active';
}

function touch(lobby: LobbyRecord, now: number): void {
  lobby.version++;
  lobby.updatedAt = Timestamp.fromMillis(now);
  lobby.expiresAt = Timestamp.fromMillis(now + IDLE_TTL_MS);
}

function preview(code: string, lobby: LobbyRecord, candidates: Candidate[], now: number): void {
  const parsed = parseFilterSelections(lobby.filters);
  if (!parsed.ok) throw new LobbyError('invalid', parsed.error, 400);
  const host = lobby.members[lobby.hostId];
  if (parsed.filters.some(({ filter }) => filter.requires.includes('library')) &&
      (!host || host.libraryState !== 'ok' || host.playtimeHidden)) {
    lobby.filteredCount = 0;
    lobby.filterUnknownCount = candidates.length;
    return;
  }
  const result = applyPool(candidates, { filters: parsed.filters }, {
    now: now / 1000, thresholds: THRESHOLDS, scope: { kind: 'lobby', code }, members: Object.keys(lobby.members),
  });
  lobby.filteredCount = result.preview.final;
  lobby.filterUnknownCount = result.preview.steps.reduce((sum, step) => sum + step.unknown, 0);
}

function hiddenPlaytime(library: FriendLibrary): boolean {
  return detectPlaytimeHidden([...library.games].map(([id, entry]) => fromIndexEntry(id, entry)));
}

function commonCandidates(libraries: FriendLibrary[], hostId: string): Candidate[] {
  const available = libraries.filter(library => library.state === 'ok').map(library => ({
    ...library, playtimeHidden: hiddenPlaytime(library),
  }));
  const first = available.find(library => library.steamId === hostId) ?? available[0];
  return intersect(available).map(game => {
    const candidate = candidateFromIndexEntry(game.appid, first.games.get(game.appid)!);
    candidate.signals.group = game.group;
    return candidate;
  });
}

function writeCommon(tx: Transaction, code: string, lobby: LobbyRecord, chunks: string[], oldCount: number): void {
  chunks.forEach((games, i) => tx.set(db.doc(paths.lobbyCommonChunk(code, i)), { games }));
  for (let i = chunks.length; i < oldCount; i++) tx.delete(db.doc(paths.lobbyCommonChunk(code, i)));
  lobby.commonChunkCount = chunks.length;
}

async function memberFor(id: string, now: number): Promise<LobbyMemberRecord> {
  const profile = (await db.doc(paths.user(id)).get()).data();
  return {
    name: typeof profile?.personaName === 'string' ? profile.personaName : id,
    avatar: typeof profile?.avatarFull === 'string' ? profile.avatarFull : null,
    state: 'present', libraryState: 'error', playtimeHidden: false, joinedAt: Timestamp.fromMillis(now),
  };
}

export async function createLobby(steamId: string, deps: LobbyDeps = {}) {
  steamIdSegment(steamId);
  await takeLobbyLimit('create', steamId, (deps.now ?? Date.now)());
  const [member, libraries] = await Promise.all([
    memberFor(steamId, (deps.now ?? Date.now)()), (deps.libraries ?? getLibraryFor)([steamId]),
  ]);
  member.libraryState = libraries[0].state;
  member.playtimeHidden = hiddenPlaytime(libraries[0]);
  const candidates = commonCandidates(libraries, steamId);
  const chunks = encodeCommon(candidates);
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = requireCode((deps.generateCode ?? generateLobbyCode)());
    const result = await runTransaction(async tx => {
      const ref = db.doc(paths.lobby(code));
      if ((await tx.get(ref)).exists) return null;
      const now = (deps.now ?? Date.now)();
      const lobby: LobbyRecord = {
        hostId: steamId, createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now),
        expiresAt: Timestamp.fromMillis(now + IDLE_TTL_MS), version: 1, status: 'active',
        filters: [], members: { [steamId]: member }, commonCount: candidates.length, commonChunkCount: 0,
        filteredCount: 0, filterUnknownCount: 0, rejected: [], votes: {}, vetoes: {},
      };
      preview(code, lobby, candidates, now);
      writeCommon(tx, code, lobby, chunks, 0);
      tx.create(ref, lobby);
      return lobbyView(code, lobby);
    });
    if (result) return result;
  }
  throw new LobbyError('unavailable', 'Could not allocate a lobby code. Please try again.', 503);
}

/** Polling reads exactly one document. Reads never extend idle expiry. */
export async function pollLobby(rawCode: string, since?: number, deps: LobbyDeps = {}) {
  const code = requireCode(rawCode);
  const snapshot = await db.doc(paths.lobby(code)).get();
  if (!snapshot.exists) throw new LobbyError('not_found', 'Lobby not found.', 404);
  const current = snapshot.data() as LobbyRecord;
  const now = (deps.now ?? Date.now)();
  if (current.status !== 'active' || current.expiresAt.toMillis() > now) {
    return current.version === since ? null : lobbyView(code, current);
  }
  // Only expiry requires a transaction. Re-read so a simultaneous mutation can extend the deadline.
  return runTransaction(async tx => {
    const snapshot = await tx.get(db.doc(paths.lobby(code)));
    if (!snapshot.exists) throw new LobbyError('not_found', 'Lobby not found.', 404);
    const lobby = snapshot.data() as LobbyRecord;
    expire(tx, code, lobby, (deps.now ?? Date.now)());
    return lobby.version === since ? null : lobbyView(code, lobby);
  });
}

async function membership(rawCode: string, steamId: string, action: 'join' | 'leave', deps: LobbyDeps) {
  const code = requireCode(rawCode);
  steamIdSegment(steamId);
  const ref = db.doc(paths.lobby(code));
  const member = action === 'join' ? await memberFor(steamId, (deps.now ?? Date.now)()) : null;
  // Steam calls stay outside transactions. Version comparison prevents publishing an intersection of stale membership.
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await pollLobby(code, undefined, deps);
    if (!current || current.status !== 'active') throw new LobbyError('expired', 'This lobby has ended.', 410);
    const ids = current.members.map(m => m.steamId);
    if (action === 'join' && ids.includes(steamId) || action === 'leave' && !ids.includes(steamId)) return current;
    if (action === 'join' && ids.length >= MAX_MEMBERS) throw new LobbyError('full', 'This lobby already has eight members.', 409);
    const nextIds = action === 'join' ? [...ids, steamId] : ids.filter(id => id !== steamId);
    const hostId = nextIds.includes(current.hostId) ? current.hostId : nextIds[0] ?? current.hostId;
    const libraries = await (deps.libraries ?? getLibraryFor)(nextIds);
    const candidates = commonCandidates(libraries, hostId);
    const chunks = encodeCommon(candidates);
    const result = await runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new LobbyError('not_found', 'Lobby not found.', 404);
      const lobby = snapshot.data() as LobbyRecord;
      const now = (deps.now ?? Date.now)();
      if (expire(tx, code, lobby, now)) return { ended: true } as const;
      if (lobby.version !== current.version) return null;
      if (action === 'join') lobby.members[steamId] = member!;
      else delete lobby.members[steamId];
      libraries.forEach(library => {
        lobby.members[library.steamId].libraryState = library.state;
        lobby.members[library.steamId].playtimeHidden = hiddenPlaytime(library);
      });
      lobby.hostId = hostId;
      if (!nextIds.length) lobby.status = 'closed';
      touch(lobby, now);
      lobby.commonCount = candidates.length;
      preview(code, lobby, candidates, now);
      writeCommon(tx, code, lobby, chunks, lobby.commonChunkCount);
      tx.set(ref, lobby);
      return { view: lobbyView(code, lobby) } as const;
    });
    if (result && 'ended' in result) throw new LobbyError('expired', 'This lobby has ended.', 410);
    if (result) return result.view;
  }
  throw new LobbyError('conflict', 'Lobby is busy. Please try again.', 409);
}

export async function joinLobby(code: string, steamId: string, ip: string, deps: LobbyDeps = {}) {
  await takeLobbyLimit('join', ip, (deps.now ?? Date.now)());
  return membership(code, steamId, 'join', deps);
}

export function leaveLobby(code: string, steamId: string, deps: LobbyDeps = {}) {
  return membership(code, steamId, 'leave', deps);
}

export type LobbyEdit = { state: LobbyMemberRecord['state'] } | { filters: FilterSelection[] };

export async function editLobby(rawCode: string, steamId: string, edit: LobbyEdit, deps: LobbyDeps = {}) {
  const code = requireCode(rawCode);
  steamIdSegment(steamId);
  if ('filters' in edit) {
    const parsed = parseFilterSelections(edit.filters);
    if (!parsed.ok) throw new LobbyError('invalid', parsed.error, 400);
  } else if (!['present', 'ready', 'away'].includes(edit.state)) throw new LobbyError('invalid', 'Invalid member state.', 400);
  const result = await runTransaction(async tx => {
    const ref = db.doc(paths.lobby(code));
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new LobbyError('not_found', 'Lobby not found.', 404);
    const lobby = snapshot.data() as LobbyRecord;
    const now = (deps.now ?? Date.now)();
    if (expire(tx, code, lobby, now)) return null;
    if (!lobby.members[steamId]) throw new LobbyError('forbidden', 'Join the lobby first.', 403);
    if ('filters' in edit) {
      if (lobby.hostId !== steamId) throw new LobbyError('forbidden', 'Only the host can edit shared filters.', 403);
      const refs = Array.from({ length: lobby.commonChunkCount }, (_, i) => db.doc(paths.lobbyCommonChunk(code, i)));
      const snapshots = refs.length ? await tx.getAll(...refs) : [];
      const candidates = snapshots.flatMap(chunk => decodeCommonChunk(chunk.data()!.games));
      // Store normalized params, never undefined fields from a caller.
      const parsed = parseFilterSelections(edit.filters);
      if (!parsed.ok) throw new LobbyError('invalid', parsed.error, 400);
      lobby.filters = parsed.filters.map(({ filter, params }) => ({ id: filter.id, params }));
      preview(code, lobby, candidates, now);
    } else lobby.members[steamId].state = edit.state;
    touch(lobby, now);
    tx.set(ref, lobby);
    return lobbyView(code, lobby);
  });
  if (!result) throw new LobbyError('expired', 'This lobby has ended.', 410);
  return result;
}

/** Privacy deletion must also work for ended lobbies, without requesting more Steam data. */
export async function removeLobbyMemberForDeletion(code: string, steamId: string): Promise<void> {
  steamIdSegment(steamId);
  const ref = db.doc(paths.lobby(code));
  for (let attempt = 0; attempt < 12; attempt++) {
    const snapshot = await ref.get();
    if (!snapshot.exists) return;
    const current = snapshot.data() as LobbyRecord;
    if (!current.members[steamId]) return;
    const ids = Object.keys(current.members).filter(id => id !== steamId);
    const hostId = ids.includes(current.hostId) ? current.hostId : ids[0] ?? '';
    // Existing indexes only: deletion never fetches another member's Steam library.
    const indexes = await firestoreSocialStore.readQitLibraries(ids);
    const libraries: FriendLibrary[] = ids.map(id => ({
      steamId: id, state: indexes.has(id) ? 'ok' : 'error', source: 'qit',
      games: indexes.get(id)?.games ?? new Map(), fetchedAt: indexes.get(id)?.syncedAt ?? Date.now(),
    }));
    const candidates = libraries.some(library => library.state !== 'ok') ? [] : commonCandidates(libraries, hostId);
    const chunks = encodeCommon(candidates);
    const committed = await runTransaction(async tx => {
      const latest = await tx.get(ref);
      if (!latest.exists) return true;
      const lobby = latest.data() as LobbyRecord;
      if (!lobby.members[steamId]) return true;
      if (lobby.version !== current.version) return false;
      delete lobby.members[steamId];
      delete lobby.votes[steamId];
      delete lobby.vetoes[steamId];
      delete lobby.result;
      lobby.hostId = hostId;
      if (!ids.length) lobby.status = 'closed';
      lobby.version++;
      lobby.updatedAt = Timestamp.now();
      lobby.commonCount = candidates.length;
      preview(code, lobby, candidates, Date.now());
      writeCommon(tx, code, lobby, chunks, lobby.commonChunkCount);
      tx.set(ref, lobby);
      return true;
    });
    if (committed) return;
  }
  throw new LobbyError('conflict', 'Lobby is busy. Please retry deletion.', 409);
}
