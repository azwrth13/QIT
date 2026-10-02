import { afterEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../src/lib/firestore';
import { IDLE_TTL_MS, MAX_MEMBERS } from '../src/lib/lobby/model';
import { decodeCommonChunk } from '../src/lib/lobby/common-cache';
import { createLobby, editLobby, generateLobbyCode, joinLobby, leaveLobby, pollLobby, takeLobbyLimit } from '../src/lib/lobby/service';
import { paths } from '../src/lib/store/paths';
import { documentSize, MAX_DOCUMENT_BYTES } from '../src/lib/store/limits';
import { patchLibIndex } from '../src/lib/store/lib-index';
import type { FriendLibrary } from '../src/lib/social/libraries';
import type { LibIndexEntry } from '../src/lib/store/types';

const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;
let seq = 0;
const id = () => `76561199${String(Date.now() % 1_000_000).padStart(6, '0')}${String(seq++).padStart(3, '0')}`;
const library = (steamId: string, entries: [number, LibIndexEntry][] = [[620, { n: 'Portal 2', p: 0 }], [730, { n: 'CS2', p: 60 }]], state: FriendLibrary['state'] = 'ok'): FriendLibrary =>
  ({ steamId, state, source: 'qit', games: new Map(state === 'ok' ? entries : []), fetchedAt: Date.now() });
const libraries = vi.fn(async (ids: readonly string[]) => ids.map(steamId => library(steamId)));
afterEach(() => { libraries.mockReset(); libraries.mockImplementation(async ids => ids.map(steamId => library(steamId))); vi.restoreAllMocks(); });

describe.skipIf(!emulated)('transactional lobby core (emulator)', () => {
  it('creates, joins, changes state, edits shared filters, leaves and polls only changed versions', async () => {
    const host = id(), guest = id();
    await db.doc(paths.user(host)).set({ personaName: 'Host', avatarFull: 'avatar' });
    const deps = { libraries };
    const created = await createLobby(host, deps);
    expect(created).toMatchObject({ hostId: host, version: 1, commonCount: 2, filteredCount: 2, members: [{ steamId: host, name: 'Host', state: 'present' }] });
    expect((await db.doc(paths.lobby(created.code)).get()).data()?.expiresAt).toBeInstanceOf(Timestamp);
    expect(await pollLobby(created.code, 1, deps)).toBeNull();
    const joined = await joinLobby(created.code, guest, id(), deps);
    expect(joined.version).toBe(2);
    expect(joined.members).toHaveLength(2);
    // Rejoining is idempotent and needs no additional library lookup.
    const calls = libraries.mock.calls.length;
    expect((await joinLobby(created.code, guest, id(), deps)).version).toBe(2);
    expect(libraries.mock.calls.length).toBe(calls);
    expect((await editLobby(created.code, guest, { state: 'ready' }, deps)).version).toBe(3);
    await expect(editLobby(created.code, guest, { filters: [] }, deps)).rejects.toMatchObject({ status: 403 });
    expect(await editLobby(created.code, host, { filters: [{ id: 'never-played' }] }, deps)).toMatchObject({ version: 4, commonCount: 2, filteredCount: 1 });
    expect(libraries.mock.calls.length).toBe(calls);
    expect(await pollLobby(created.code, 3, deps)).toMatchObject({ version: 4 });
    expect(await pollLobby(created.code, 4, deps)).toBeNull();
    expect((await leaveLobby(created.code, host, deps))).toMatchObject({ version: 5, hostId: guest, members: [{ steamId: guest }] });
    expect((await leaveLobby(created.code, guest, deps))).toMatchObject({ version: 6, status: 'closed', commonCount: 0 });
    expect((await db.doc(paths.lobbyCommonChunk(created.code, 0)).get()).exists).toBe(false);
  });

  it('uses the merged getLibraryFor and intersect with actual QIT library indexes', async () => {
    const host = id(), guest = id();
    for (const steamId of [host, guest]) await db.doc(paths.user(steamId)).set({ public: true, lastSyncedAt: new Date().toISOString() });
    await patchLibIndex(host, { 620: { n: 'Portal 2', p: 0 }, 730: { n: 'CS2', p: 30 } }, { create: true });
    await patchLibIndex(guest, { 620: { n: 'Portal 2', p: 10 }, 10: { n: 'Counter-Strike', p: 5 } }, { create: true });
    const created = await createLobby(host);
    expect((await joinLobby(created.code, guest, id())).commonCount).toBe(1);
    const cached = decodeCommonChunk((await db.doc(paths.lobbyCommonChunk(created.code, 0)).get()).data()!.games);
    expect(cached[0]).toMatchObject({ appid: 620, signals: { group: { members: [
      { steamId: host, playtimeForever: 0 }, { steamId: guest, playtimeForever: 10 },
    ] } } });
  });

  it('polls an unchanged lobby with one parent read and no transaction or library lookup', async () => {
    const created = await createLobby(id(), { libraries });
    libraries.mockClear();
    const docs = vi.spyOn(db, 'doc');
    const transactions = vi.spyOn(db, 'runTransaction');
    expect(await pollLobby(created.code, created.version)).toBeNull();
    expect(docs).toHaveBeenCalledExactlyOnceWith(paths.lobby(created.code));
    expect(transactions).not.toHaveBeenCalled();
    expect(libraries).not.toHaveBeenCalled();
  });

  it('refuses the ninth member and preserves all concurrent joins and version increments', async () => {
    const host = id();
    const created = await createLobby(host, { libraries });
    const guests = Array.from({ length: MAX_MEMBERS - 1 }, id);
    await Promise.all(guests.map(guest => joinLobby(created.code, guest, guest, { libraries })));
    const full = await pollLobby(created.code);
    expect(full?.members.map(m => m.steamId).sort()).toEqual([host, ...guests].sort());
    expect(full?.version).toBe(8);
    const cached = decodeCommonChunk((await db.doc(paths.lobbyCommonChunk(created.code, 0)).get()).data()!.games);
    expect(cached[0].signals.group?.members.map(m => m.steamId).sort()).toEqual([host, ...guests].sort());
    await expect(joinLobby(created.code, id(), id(), { libraries })).rejects.toMatchObject({ status: 409, code: 'full' });
    expect((await pollLobby(created.code))?.version).toBe(8);
  }, 60_000);

  it('atomically refuses one of two concurrent attempts for the last slot', async () => {
    const created = await createLobby(id(), { libraries });
    for (let i = 0; i < 6; i++) await joinLobby(created.code, id(), id(), { libraries });
    const results = await Promise.allSettled([joinLobby(created.code, id(), id(), { libraries }), joinLobby(created.code, id(), id(), { libraries })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await pollLobby(created.code))?.members).toHaveLength(8);
  }, 60_000);

  it('expires exactly six hours after the last mutation, bumps once, and polling never refreshes idle expiry', async () => {
    let now = Date.now();
    const host = id();
    const deps = { libraries, now: () => now };
    const created = await createLobby(host, deps);
    now += 1000;
    await pollLobby(created.code, 1, deps);
    expect((await db.doc(paths.lobby(created.code)).get()).data()?.expiresAt.toMillis()).toBe(created.expiresAt);
    const edited = await editLobby(created.code, host, { state: 'away' }, deps);
    expect(edited.expiresAt).toBe(now + IDLE_TTL_MS);
    now += IDLE_TTL_MS;
    expect(await pollLobby(created.code, 2, deps)).toMatchObject({ status: 'expired', version: 3 });
    expect(await pollLobby(created.code, 3, deps)).toBeNull();
    await expect(joinLobby(created.code, id(), id(), deps)).rejects.toMatchObject({ status: 410 });
    await expect(editLobby(created.code, host, { state: 'present' }, deps)).rejects.toMatchObject({ status: 410 });
    expect((await pollLobby(created.code, undefined, deps))?.version).toBe(3);
  });

  it('commits expiry even when a mutation first observes it and refuses that mutation', async () => {
    let now = Date.now();
    const host = id();
    const deps = { libraries, now: () => now };
    const created = await createLobby(host, deps);
    now += IDLE_TTL_MS;
    await expect(editLobby(created.code, host, { state: 'ready' }, deps)).rejects.toMatchObject({ status: 410 });
    expect((await db.doc(paths.lobby(created.code)).get()).data()).toMatchObject({ status: 'expired', version: 2 });
  });

  it('reports private and failed member libraries without failing the intersection', async () => {
    const host = id(), privateId = id(), failedId = id();
    libraries.mockImplementation(async ids => ids.map(steamId => library(steamId, undefined, steamId === privateId ? 'private' : steamId === failedId ? 'error' : 'ok')));
    const created = await createLobby(host, { libraries });
    await joinLobby(created.code, privateId, id(), { libraries });
    const joined = await joinLobby(created.code, failedId, id(), { libraries });
    expect(joined.commonCount).toBe(2);
    expect(joined.members.map(m => m.libraryState)).toEqual(['ok', 'private', 'error']);
  });

  it('never treats hidden host playtime as never played', async () => {
    libraries.mockImplementation(async ids => ids.map(steamId => library(steamId, Array.from({ length: 5 }, (_, i) => [i + 1, { n: 'Game', p: 0 }]))));
    const host = id();
    const created = await createLobby(host, { libraries });
    expect(await editLobby(created.code, host, { filters: [{ id: 'never-played' }] }, { libraries })).toMatchObject({ commonCount: 5, filteredCount: 0, filterUnknownCount: 5 });
  });

  it('collision-checks codes without replacing a lobby or spending multiple creation tokens', async () => {
    const host = id();
    const first = await createLobby(host, { libraries });
    const secondCode = generateLobbyCode();
    const generateCode = vi.fn().mockReturnValueOnce(first.code).mockReturnValue(secondCode);
    expect((await createLobby(host, { libraries, generateCode })).code).toBe(secondCode);
    expect((await pollLobby(first.code))?.hostId).toBe(host);
    expect(generateCode).toHaveBeenCalledTimes(2);
    await createLobby(host, { libraries });
    await expect(createLobby(host, { libraries })).rejects.toMatchObject({ status: 429, retryAfter: expect.any(Number) });
    expect(libraries).toHaveBeenCalledTimes(3);
  });

  it('persists IP join budgets and safely serializes simultaneous attempts', async () => {
    const ip = id();
    const now = Date.now();
    for (let i = 0; i < 19; i++) await takeLobbyLimit('join', ip, now);
    const results = await Promise.allSettled([takeLobbyLimit('join', ip, now), takeLobbyLimit('join', ip, now)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await expect(takeLobbyLimit('join', ip, now)).rejects.toMatchObject({ status: 429, retryAfter: 3 });
    await expect(takeLobbyLimit('join', ip, now + 3000)).resolves.toBeUndefined();
    await expect(takeLobbyLimit('join', id(), now)).resolves.toBeUndefined();
  });

  it('chunks a large common library below document limits and filters it without recomputing libraries', async () => {
    const host = id();
    libraries.mockImplementation(async ids => ids.map(steamId => library(steamId, Array.from({ length: 8000 }, (_, i) => [i + 1, { n: `Long game title ${i}`, p: i % 2 ? 10 : 0 }]))));
    const created = await createLobby(host, { libraries });
    expect(created.commonCount).toBe(8000);
    const parent = (await db.doc(paths.lobby(created.code)).get()).data()!;
    expect(parent.commonChunkCount).toBeGreaterThan(1);
    for (let i = 0; i < parent.commonChunkCount; i++) {
      const path = paths.lobbyCommonChunk(created.code, i);
      expect(documentSize(path, (await db.doc(path).get()).data()!)).toBeLessThan(MAX_DOCUMENT_BYTES);
    }
    expect(await editLobby(created.code, host, { filters: [{ id: 'never-played' }] }, { libraries })).toMatchObject({ filteredCount: 4000 });
    expect(libraries).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 7; i++) {
      expect((await joinLobby(created.code, id(), id(), { libraries })).commonCount).toBe(8000);
    }
    expect(await editLobby(created.code, host, { filters: [{ id: 'never-played' }] }, { libraries })).toMatchObject({ filteredCount: 4000, members: expect.any(Array) });
    expect((await pollLobby(created.code))?.members).toHaveLength(8);
  }, 60_000);
});
