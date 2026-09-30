import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/firestore';
import { createSteamClient } from '../src/lib/steam/client';
import { FRIENDS_TTL_MS, PINNED_MESSAGE, getFriends } from '../src/lib/social/friends';
import { encodeGames, getLibraryFor } from '../src/lib/social/libraries';
import { pinPlayer, unpinPlayer } from '../src/lib/social/pinned';
import { firestoreSocialStore as store } from '../src/lib/social/store';
import { patchLibIndex } from '../src/lib/store/lib-index';
import { paths } from '../src/lib/store/paths';
import type { LibIndexEntry, PublicLibraryRecord } from '../src/lib/store/types';

// Emulator-only (npm run test:firestore). Skipped elsewhere so it can never touch a real project.
const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;

let nextId = 0;
const freshUser = () => `7656119902${String(Date.now() % 1e5).padStart(5, '0')}${String(nextId++ % 100).padStart(2, '0')}`;
const idOf = (n: number) => `76561198${String(n).padStart(9, '0')}`;
const NOW = Date.parse('2026-09-29T12:00:00Z');

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function steam(handler: (url: URL) => unknown) {
  const calls: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const body = handler(url);
    return body === null ? Response.json({}, { status: 401 }) : Response.json(body);
  });
  vi.stubEnv('STEAM_API_KEY', 'test-key');
  return { calls, client: createSteamClient({ fetch: fetchMock as unknown as typeof fetch, sleep: async () => {}, retries: 0 }) };
}

const summaryOf = (id: string, extra: Record<string, unknown> = {}) => ({
  steamid: id, personaname: `P${id.slice(-3)}`, profileurl: `https://steamcommunity.com/profiles/${id}`, avatarfull: 'full', avatarmedium: 'medium',
  communityvisibilitystate: 3, ...extra,
});

describe.skipIf(!emulated)('friends snapshot (emulator)', () => {
  it('stores the snapshot under meta/friends and serves it for 15 minutes', async () => {
    const owner = freshUser();
    const friend = idOf(1);
    const world = steam(url => url.pathname.includes('GetFriendList')
      ? { friendslist: { friends: [{ steamid: friend, relationship: 'friend', friend_since: 1 }] } }
      : { response: { players: [summaryOf(friend, { personastate: 1, gameextrainfo: 'Portal 2', gameid: '620' })] } });
    let now = NOW;
    const deps = { client: world.client, now: () => now };
    const first = await getFriends(owner, deps);
    expect(first.friends[0]).toMatchObject({ steamId: friend, status: 1, currentGame: { appid: 620, name: 'Portal 2' } });
    const stored = (await db.doc(paths.friendsMeta(owner)).get()).data()!;
    expect(stored).toMatchObject({ state: 'ok', ids: [friend], fetchedAt: expect.any(Timestamp) });
    expect(stored.summaries[friend]).toEqual({ name: `P${friend.slice(-3)}`, url: `https://steamcommunity.com/profiles/${friend}`, avatar: 'full', avatarMedium: 'medium', status: 1, gameId: 620, game: 'Portal 2' });
    now += FRIENDS_TTL_MS - 1;
    expect(await getFriends(owner, deps)).toEqual(first);
    expect(world.calls).toHaveLength(2);
  });

  it('falls back to pinned players for a private list, and a new pin is picked up without a full refresh', async () => {
    const owner = freshUser();
    const [a, b] = [idOf(2), idOf(3)];
    const world = steam(url => url.pathname.includes('GetFriendList') ? null : url.pathname.includes('ResolveVanityURL')
      ? { response: { success: 1, steamid: b } }
      : { response: { players: url.searchParams.get('steamids')!.split(',').map(id => summaryOf(id)) } });
    const deps = { client: world.client, now: () => NOW };
    expect((await pinPlayer(owner, a, deps))).toMatchObject({ ok: true, pinned: [a] });
    expect(await getFriends(owner, deps)).toMatchObject({ source: 'pinned', message: PINNED_MESSAGE, friends: [{ steamId: a }] });
    expect(await pinPlayer(owner, 'somebody', deps)).toMatchObject({ ok: true, pinned: [a, b] });
    const lists = world.calls.filter(url => url.pathname.includes('GetFriendList')).length;
    expect((await getFriends(owner, deps)).friends.map(friend => friend.steamId)).toEqual([a, b]);
    expect(world.calls.filter(url => url.pathname.includes('GetFriendList')).length).toBe(lists);
    expect((await db.doc(paths.friendsMeta(owner)).get()).data()!.fetchedAt.toMillis()).toBe(NOW);
    await unpinPlayer(owner, a, deps);
    expect((await getFriends(owner, deps)).friends.map(friend => friend.steamId)).toEqual([b]);
  });
});

describe.skipIf(!emulated)('pinned players (emulator)', () => {
  it('keeps every pin when a few are added at once', async () => {
    const owner = freshUser();
    const ids = Array.from({ length: 4 }, (_, i) => idOf(100 + i));
    await Promise.all(ids.map(id => store.updatePinned(owner, current => current.includes(id) ? null : [...current, id])));
    expect([...await store.readPinned(owner)].sort()).toEqual(ids);
  });

  it('leaves the stored list alone when the change says so', async () => {
    const owner = freshUser();
    await store.updatePinned(owner, () => [idOf(1)]);
    expect(await store.updatePinned(owner, () => null)).toEqual([idOf(1)]);
    expect(await store.readPinned(owner)).toEqual([idOf(1)]);
  });
});

describe.skipIf(!emulated)('friend libraries (emulator)', () => {
  it('reads QIT users from the library index, but asks Steam when their last known profile was private', async () => {
    const qit = freshUser();
    const hidden = freshUser();
    const unsynced = freshUser();
    const lastSyncedAt = new Date().toISOString();
    for (const [id, isPublic] of [[qit, true], [hidden, false], [unsynced, true]] as const) await db.doc(paths.user(id)).set({ steamId: id, public: isPublic, lastSyncedAt });
    for (const id of [qit, hidden]) await patchLibIndex(id, { 620: { n: 'Portal 2', p: 90 }, 730: { n: 'CS2', p: 0 } }, { create: true });
    const world = steam(url => url.pathname.includes('GetPlayerSummaries')
      ? { response: { players: url.searchParams.get('steamids')!.split(',').map(id => summaryOf(id)) } }
      : { response: { game_count: 1, games: [{ appid: 10, name: 'Counter-Strike', playtime_forever: 3 }] } });
    const [fromIndex, fromSteamHidden, fromSteamUnsynced] = await getLibraryFor([qit, hidden, unsynced], { client: world.client });
    expect(fromIndex).toMatchObject({ state: 'ok', source: 'qit' });
    expect([...fromIndex.games.keys()].sort()).toEqual([620, 730]);
    expect(fromSteamHidden).toMatchObject({ state: 'ok', source: 'steam' });
    expect([...fromSteamHidden.games.keys()]).toEqual([10]);
    expect(fromSteamUnsynced.source).toBe('steam');
    expect(world.calls.some(url => url.searchParams.get('steamid') === qit || url.searchParams.get('steamids') === qit)).toBe(false);
  });

  it('leaves out a QIT user whose stale index is refreshed and found private, without touching their user document', async () => {
    const stale = freshUser();
    await db.doc(paths.user(stale)).set({ steamId: stale, public: true, lastSyncedAt: new Date().toISOString() });
    await patchLibIndex(stale, { 620: { n: 'Portal 2', p: 90 } }, { create: true });
    const world = steam(url => url.pathname.includes('GetPlayerSummaries')
      ? { response: { players: [summaryOf(stale, { communityvisibilitystate: 1 })] } }
      : null);
    const [library] = await getLibraryFor([stale], { client: world.client, now: () => Date.now() + 31 * 60 * 1000 });
    expect(library).toMatchObject({ state: 'private', source: 'steam' });
    expect(library.games.size).toBe(0);
    expect((await db.doc(paths.user(stale)).get()).data()?.public).toBe(true);
  });

  it('uses the index when a recent sync found no changes, even though the index was written long ago', async () => {
    const id = freshUser();
    await patchLibIndex(id, { 620: { n: 'Portal 2', p: 90 } }, { create: true });
    const later = Date.now() + 2 * 24 * 3_600_000;
    await db.doc(paths.user(id)).set({ steamId: id, public: true, lastSyncedAt: new Date(later - 60_000).toISOString() });
    const world = steam(() => { throw new Error('Steam should not be called'); });
    const [library] = await getLibraryFor([id], { client: world.client, now: () => later });
    expect(library).toMatchObject({ state: 'ok', source: 'qit', fetchedAt: later - 60_000 });
    expect(world.calls).toEqual([]);
  });

  it('caches an 8,000-game Steam library in one document and serves it back without Steam', async () => {
    const friend = freshUser();
    const owned = Array.from({ length: 8000 }, (_, i) => ({
      appid: 10 * (i + 1), name: `A fairly long game title number ${i}`, img_icon_url: 'a'.repeat(40), playtime_forever: 100 + i, playtime_2weeks: 0, rtime_last_played: 1_700_000_000,
    }));
    const world = steam(url => url.pathname.includes('GetPlayerSummaries')
      ? { response: { players: [summaryOf(friend)] } } : { response: { game_count: owned.length, games: owned } });
    let now = NOW;
    const deps = { client: world.client, now: () => now };
    const [live] = await getLibraryFor([friend], deps);
    expect(live.games.size).toBe(8000);
    const record = (await db.doc(paths.publicLibrary(friend)).get()).data()!;
    expect(record).toMatchObject({ state: 'ok', fetchedAt: Timestamp.fromMillis(NOW), expiresAt: Timestamp.fromMillis(NOW + 30 * 60_000) });
    const calls = world.calls.length;
    now += 60_000;
    const [cached] = await getLibraryFor([friend], deps);
    expect(world.calls.length).toBe(calls);
    expect(cached.games).toEqual(live.games);
  });

  it('does not write a library that is too large for one document, and still returns it', async () => {
    const friend = freshUser();
    const big = new Map<number, LibIndexEntry>(Array.from({ length: 20000 }, (_, i) => [i + 1, { n: `A fairly long game title number ${i} `.repeat(3), p: 1 }]));
    const record: PublicLibraryRecord = { state: 'ok', games: encodeGames(big), fetchedAt: Timestamp.fromMillis(NOW), expiresAt: Timestamp.fromMillis(NOW + 1000) };
    await store.writePublicLibrary(friend, record);
    expect((await db.doc(paths.publicLibrary(friend)).get()).exists).toBe(false);
  });

  it('ignores a malformed cache document', async () => {
    const friend = freshUser();
    await db.doc(paths.publicLibrary(friend)).set({ state: 'ok', games: 5 });
    expect((await store.readPublicLibraries([friend])).size).toBe(0);
  });
});
