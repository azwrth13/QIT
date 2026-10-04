import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../src/lib/firestore';
import { paths } from '../src/lib/store/paths';
import { commitInBatches } from '../src/lib/store/tx';
import { patchLibIndex } from '../src/lib/store/lib-index';
import { createLobby, joinLobby } from '../src/lib/lobby/service';
import { decodeCommonChunk } from '../src/lib/lobby/common-cache';
import { exportUserData, deleteUserData } from '../src/lib/privacy/data';
import { POST as exportRoute } from '../src/app/api/user/data/export/route';
import { POST as deleteRoute } from '../src/app/api/user/data/delete/route';
import { getSteamId } from '../src/lib/auth';
import type { FriendLibrary } from '../src/lib/social/libraries';

vi.mock('../src/lib/auth', () => ({ getSteamId: vi.fn() }));
let sequence = 0;
const id = () => `76561199${String(Date.now() % 1_000_000).padStart(6, '0')}${String(sequence++).padStart(3, '0')}`;
function request(action: string, body: unknown = {}, origin: string | null = 'https://qit.test') {
  return new Request(`https://qit.test/api/user/data/${action}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), 'x-forwarded-for': id() }, body: JSON.stringify(body) });
}
const confirmation = { confirmation: 'DELETE MY DATA' };
beforeEach(() => { vi.mocked(getSteamId).mockReset(); vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.test'); });

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('privacy data controls (emulator)', () => {
  it('exports only the authenticated tree, including orphan descendants, as a private JSON download', async () => {
    const caller = id(), other = id();
    await db.doc(paths.user(caller)).set({ personaName: 'Caller' });
    await db.doc(paths.user(other)).set({ secret: 'other account private value' });
    await db.doc(`${paths.user(caller)}/future/missing/deeper/value`).set({ custom: 'owned descendant' });
    await db.doc(paths.roll(caller, 'roll')).set({ appid: 620, at: Timestamp.now() });
    await db.doc(paths.publicLibrary(other)).set({ secret: 'other public cache' });
    await db.doc(paths.publicLibrary(caller)).set({ games: 'own cache' });
    vi.mocked(getSteamId).mockResolvedValue(caller);
    const response = await exportRoute(request(`export?steamId=${other}`, { steamId: other }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(`qit-data-${caller}.json`);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toMatchObject({ steamId: caller, documents: { '.': { personaName: 'Caller' },
      'future/missing/deeper/value': { custom: 'owned descendant' }, 'rolls/roll': { appid: 620 } }, publicLibrary: { games: 'own cache' } });
    expect(JSON.stringify(body)).not.toContain('other account private value');
    expect(JSON.stringify(body)).not.toContain('other public cache');
    await deleteUserData(caller);
    await db.doc(paths.user(other)).delete();
    await db.doc(paths.publicLibrary(other)).delete();
  });

  it('recursively deletes known and unknown subcollections across batches, preserves another user and safely repeats', async () => {
    const caller = id(), other = id();
    for (const user of [caller, other]) await db.doc(paths.user(user)).set({ owner: user });
    const collections = ['games', 'libIndex', 'achievementProgress', 'meta', 'rolls', 'events', 'prefs', 'stats', 'daily', 'challenges', 'future'];
    const ownPaths = collections.map(collection => `${paths.user(caller)}/${collection}/record`);
    ownPaths.push(`${paths.user(caller)}/missing/parent/unknown/deep`);
    for (let i = 0; i < 460; i++) ownPaths.push(paths.userGame(caller, i + 1));
    await commitInBatches(ownPaths.map(path => batch => { batch.set(db.doc(path), { value: 'caller' }); }));
    const otherRecord = db.doc(paths.event(other, 'private'));
    await otherRecord.set({ secret: 'leave me alone' });
    await db.doc(paths.publicLibrary(caller)).set({ games: 'cached' });
    vi.mocked(getSteamId).mockResolvedValue(caller);
    const response = await deleteRoute(request('delete', confirmation));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/__session=;.*Max-Age=0/i);
    for (const path of ownPaths) expect((await db.doc(path).get()).exists, path).toBe(false);
    expect((await db.doc(paths.user(caller)).get()).exists).toBe(false);
    expect((await db.doc(paths.publicLibrary(caller)).get()).exists).toBe(false);
    expect((await db.doc(paths.user(other)).get()).data()).toEqual({ owner: other });
    expect((await otherRecord.get()).data()).toEqual({ secret: 'leave me alone' });
    expect((await deleteRoute(request('delete', confirmation))).status).toBe(200);
    expect((await exportUserData(caller)).documents).toEqual({});
    await deleteUserData(other);
  }, 60_000);

  it('removes lobby membership and cached playtime even from expired lobbies, transfers host and preserves other users', async () => {
    const caller = id(), other = id();
    for (const user of [caller, other]) {
      await db.doc(paths.user(user)).set({ personaName: user, public: true, lastSyncedAt: new Date().toISOString() });
      await patchLibIndex(user, { 620: { n: 'Portal 2', p: user === caller ? 123 : 456 } }, { create: true });
    }
    const libraries = async (ids: readonly string[]): Promise<FriendLibrary[]> => ids.map(steamId => ({ steamId,
      state: 'ok', source: 'qit', games: new Map([[620, { n: 'Portal 2', p: steamId === caller ? 123 : 456 }]]), fetchedAt: Date.now() }));
    const lobby = await createLobby(caller, { libraries });
    await joinLobby(lobby.code, other, id(), { libraries });
    const ref = db.doc(paths.lobby(lobby.code));
    await ref.update({ status: 'expired', votes: { [caller]: true, [other]: true }, vetoes: { [caller]: [620] }, result: { participants: [caller, other] } });
    const exported = await exportUserData(caller);
    expect(exported.creationLimit).not.toBeNull();
    expect(exported.lobbies[0]).toMatchObject({ code: lobby.code, isHost: true, member: { name: caller } });
    expect(JSON.stringify(exported.lobbies)).not.toContain(other);
    await deleteUserData(caller);
    const remaining = (await ref.get()).data()!;
    expect(remaining.hostId).toBe(other);
    expect(remaining.members[caller]).toBeUndefined();
    expect(remaining.members[other]).toBeDefined();
    expect(remaining.votes).toEqual({ [other]: true });
    expect(remaining.vetoes).toEqual({});
    expect(remaining.result).toBeUndefined();
    const cached = decodeCommonChunk((await db.doc(paths.lobbyCommonChunk(lobby.code, 0)).get()).data()!.games);
    expect(cached[0].signals.library.playtimeForever).toBe(456);
    expect(JSON.stringify(cached)).not.toContain(caller);
    await deleteUserData(caller);
    expect((await ref.get()).data()?.version).toBe(remaining.version);
    expect((await exportUserData(caller)).creationLimit).toBeNull();
    expect((await db.doc(paths.user(other)).get()).exists).toBe(true);
    await deleteUserData(other);
    expect((await ref.get()).data()).toMatchObject({ status: 'closed', hostId: '', members: {}, commonChunkCount: 0 });
    expect((await db.doc(paths.lobbyCommonChunk(lobby.code, 0)).get()).exists).toBe(false);
    await ref.delete();
  });

  it('refuses unauthenticated, cross-origin and missing-origin requests and requires explicit confirmation', async () => {
    const caller = id();
    await db.doc(paths.user(caller)).set({ safe: true });
    vi.mocked(getSteamId).mockResolvedValue(null);
    for (const route of [exportRoute, deleteRoute]) expect((await route(request('data', confirmation))).status).toBe(401);
    vi.mocked(getSteamId).mockResolvedValue(caller);
    for (const route of [exportRoute, deleteRoute]) {
      expect((await route(request('data', confirmation, 'https://evil.test'))).status).toBe(403);
      expect((await route(request('data', confirmation, null))).status).toBe(403);
    }
    expect((await deleteRoute(request('delete', {}))).status).toBe(400);
    expect((await db.doc(paths.user(caller)).get()).data()).toEqual({ safe: true });
    await deleteUserData(caller);
  });
});
