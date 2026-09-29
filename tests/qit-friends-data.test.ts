import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSteamClient } from '../src/lib/steam/client';
import type { FriendsMetaRecord, LibIndexEntry, PublicLibraryRecord } from '../src/lib/store/types';
import { NO_FRIENDS_MESSAGE, PINNED_MESSAGE, PRIVATE_LIST_MESSAGE, FRIENDS_TTL_MS, getFriends } from '../src/lib/social/friends';
import {
  ERROR_TTL_MS, MAX_LIBRARY_IDS, NEGATIVE_TTL_MS, PUBLIC_LIBRARY_TTL_MS, QIT_INDEX_MAX_AGE_MS, decodeGames, encodeGames, getLibraryFor, getSteamLibrary,
} from '../src/lib/social/libraries';
import { MAX_PINNED, pinPlayer, unpinPlayer } from '../src/lib/social/pinned';
import { fitsInDocument, parseFriendsRecord, parsePinnedIds, type QitLibrary, type SocialStore } from '../src/lib/social/store';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const owner = '76561198000000001';
const idOf = (n: number) => `76561198${String(n).padStart(9, '0')}`;

function memoryStore(overrides: Partial<SocialStore> = {}) {
  const state = {
    friends: new Map<string, FriendsMetaRecord>(),
    pinned: new Map<string, string[]>(),
    libraries: new Map<string, PublicLibraryRecord>(),
    qit: new Map<string, QitLibrary>(),
    notPublic: new Set<string>(),
  };
  const store: SocialStore = {
    readFriends: async id => state.friends.get(id) ?? null,
    writeFriends: async (id, record) => { state.friends.set(id, record); },
    readPinned: async id => state.pinned.get(id) ?? [],
    updatePinned: async (id, change) => {
      const current = state.pinned.get(id) ?? [];
      const next = change(current);
      if (next === null) return current;
      state.pinned.set(id, next);
      return next;
    },
    readPublicLibraries: async ids => new Map(ids.flatMap(id => state.libraries.has(id) ? [[id, state.libraries.get(id)!] as const] : [])),
    writePublicLibrary: async (id, record) => { state.libraries.set(id, record); },
    readQitLibraries: async ids => new Map(ids.flatMap(id => state.qit.has(id) && !state.notPublic.has(id) ? [[id, state.qit.get(id)!] as const] : [])),
    markNotPublic: async id => { state.notPublic.add(id); },
    ...overrides,
  };
  return { store, state };
}

type Player = { steamid: string; personaname?: string; communityvisibilitystate?: number; personastate?: number; gameextrainfo?: string; gameid?: string; profileurl?: string; avatarfull?: string; avatarmedium?: string };
const player = (steamid: string, extra: Partial<Player> = {}): Player => ({
  steamid, personaname: `Player ${steamid.slice(-4)}`, profileurl: `https://steamcommunity.com/profiles/${steamid}`,
  avatarfull: `https://avatars.example/${steamid}_full.jpg`, avatarmedium: `https://avatars.example/${steamid}_medium.jpg`,
  communityvisibilitystate: 3, ...extra,
});

interface World {
  friendLists: Record<string, { status: number; friends?: string[] } | 'fail'>;
  players: Record<string, Player>;
  owned: Record<string, { status?: number; body: unknown } | 'fail'>;
  vanity: Record<string, string>;
}

function steamWorld(world: Partial<World> = {}) {
  const data: World = { friendLists: {}, players: {}, owned: {}, vanity: {}, ...world };
  const calls: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const name = url.pathname.split('/')[2];
    if (name === 'GetFriendList') {
      const list = data.friendLists[url.searchParams.get('steamid')!];
      if (!list || list === 'fail') return new Response('', { status: 500 });
      if (list.status !== 200) return Response.json({}, { status: list.status });
      return Response.json({ friendslist: { friends: (list.friends ?? []).map(steamid => ({ steamid, relationship: 'friend', friend_since: 1 })) } });
    }
    if (name === 'GetPlayerSummaries') {
      const ids = url.searchParams.get('steamids')!.split(',');
      return Response.json({ response: { players: ids.flatMap(id => data.players[id] ? [data.players[id]] : []) } });
    }
    if (name === 'GetOwnedGames') {
      const owned = data.owned[url.searchParams.get('steamid')!];
      if (!owned || owned === 'fail') return new Response('', { status: 500 });
      return Response.json(owned.body, { status: owned.status ?? 200 });
    }
    if (name === 'ResolveVanityURL') {
      const steamid = data.vanity[url.searchParams.get('vanityurl')!];
      return Response.json({ response: steamid ? { success: 1, steamid } : { success: 42 } });
    }
    return new Response('', { status: 404 });
  });
  const client = createSteamClient({ fetch: fetchMock as unknown as typeof fetch, random: () => 0.5, sleep: async () => {}, retries: 0 });
  const count = (name: string) => calls.filter(url => url.pathname.includes(name)).length;
  return { client, data, calls, count, fetchMock };
}

beforeEach(() => {
  vi.stubEnv('STEAM_API_KEY', 'test-key-do-not-leak');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('friends snapshot', () => {
  const friendA = idOf(10);
  const friendB = idOf(11);

  function publicWorld() {
    return steamWorld({
      friendLists: { [owner]: { status: 200, friends: [friendA, friendB, idOf(99)] } },
      players: {
        [friendA]: player(friendA, { personastate: 1, gameextrainfo: 'Portal 2', gameid: '620' }),
        [friendB]: player(friendB, { personastate: 0 }),
      },
    });
  }

  it('maps friends with status and current game, keeping the fields the home page reads', async () => {
    const steam = publicWorld();
    const { store, state } = memoryStore();
    const result = await getFriends(owner, { store, client: steam.client, now: () => NOW });
    expect(result).toEqual({
      source: 'friends',
      friends: [
        { steamId: friendA, personaName: 'Player 0010', profileUrl: `https://steamcommunity.com/profiles/${friendA}`,
          avatarFull: `https://avatars.example/${friendA}_full.jpg`, avatarMedium: `https://avatars.example/${friendA}_medium.jpg`,
          status: 1, currentGame: { appid: 620, name: 'Portal 2' } },
        { steamId: friendB, personaName: 'Player 0011', profileUrl: `https://steamcommunity.com/profiles/${friendB}`,
          avatarFull: `https://avatars.example/${friendB}_full.jpg`, avatarMedium: `https://avatars.example/${friendB}_medium.jpg`, status: 0 },
      ],
    });
    expect(state.friends.get(owner)).toMatchObject({ state: 'ok', ids: [friendA, friendB, idOf(99)] });
  });

  it('serves the snapshot for 15 minutes and refreshes after that', async () => {
    const steam = publicWorld();
    const { store } = memoryStore();
    let now = NOW;
    const deps = { store, client: steam.client, now: () => now };
    await getFriends(owner, deps);
    now += FRIENDS_TTL_MS - 1;
    await getFriends(owner, deps);
    expect(steam.count('GetFriendList')).toBe(1);
    now += 2;
    await getFriends(owner, deps);
    expect(steam.count('GetFriendList')).toBe(2);
    expect(steam.count('GetPlayerSummaries')).toBe(2);
  });

  it('refreshes when the snapshot is dated in the future', async () => {
    const steam = publicWorld();
    const { store, state } = memoryStore();
    state.friends.set(owner, { ids: [], summaries: {}, state: 'ok', fetchedAt: Timestamp.fromMillis(NOW + 60_000) });
    const result = await getFriends(owner, { store, client: steam.client, now: () => NOW });
    expect(result.friends).toHaveLength(2);
  });

  it('batches more than 100 friends into several summary calls', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => idOf(1000 + index));
    const steam = steamWorld({
      friendLists: { [owner]: { status: 200, friends: ids } },
      players: Object.fromEntries(ids.map(id => [id, player(id)])),
    });
    const { store } = memoryStore();
    const result = await getFriends(owner, { store, client: steam.client, now: () => NOW });
    expect(result.friends).toHaveLength(101);
    expect(steam.calls.filter(url => url.pathname.includes('GetPlayerSummaries')).map(url => url.searchParams.get('steamids')!.split(',').length).sort()).toEqual([1, 100]);
  });

  it('tells the user when there are no friends, and does not call Steam for summaries', async () => {
    const steam = steamWorld({ friendLists: { [owner]: { status: 200, friends: [] } } });
    const { store } = memoryStore();
    expect(await getFriends(owner, { store, client: steam.client, now: () => NOW })).toEqual({ friends: [], message: NO_FRIENDS_MESSAGE, source: 'friends' });
    expect(steam.count('GetPlayerSummaries')).toBe(0);
  });

  it('shares one refresh between concurrent calls', async () => {
    const steam = publicWorld();
    const { store } = memoryStore();
    const deps = { store, client: steam.client, now: () => NOW };
    await Promise.all([getFriends(owner, deps), getFriends(owner, deps), getFriends(owner, deps)]);
    expect(steam.count('GetFriendList')).toBe(1);
  });

  it('does not call Steam when the snapshot is fresh', async () => {
    const steam = publicWorld();
    const { store, state } = memoryStore();
    state.friends.set(owner, { ids: [friendA], summaries: { [friendA]: { name: 'Cached', url: 'u', avatar: 'a' } }, state: 'ok', fetchedAt: Timestamp.fromMillis(NOW - 1000) });
    const result = await getFriends(owner, { store, client: steam.client, now: () => NOW });
    expect(result.friends).toEqual([{ steamId: friendA, personaName: 'Cached', profileUrl: 'u', avatarFull: 'a', avatarMedium: 'a' }]);
    expect(steam.fetchMock).not.toHaveBeenCalled();
  });

  describe('private friends list', () => {
    const pinnedId = idOf(50);

    it('explains the private list when nothing is pinned', async () => {
      const steam = steamWorld({ friendLists: { [owner]: { status: 401 } } });
      const { store, state } = memoryStore();
      expect(await getFriends(owner, { store, client: steam.client, now: () => NOW })).toEqual({ friends: [], message: PRIVATE_LIST_MESSAGE, source: 'friends' });
      expect(state.friends.get(owner)).toMatchObject({ state: 'private', ids: [] });
      expect(steam.count('GetPlayerSummaries')).toBe(0);
    });

    it('shows the pinned players instead, from the same snapshot', async () => {
      const steam = steamWorld({ friendLists: { [owner]: { status: 401 } }, players: { [pinnedId]: player(pinnedId, { personastate: 3 }) } });
      const { store, state } = memoryStore();
      state.pinned.set(owner, [pinnedId, idOf(51)]);
      const deps = { store, client: steam.client, now: () => NOW };
      const result = await getFriends(owner, deps);
      expect(result).toMatchObject({ source: 'pinned', message: PINNED_MESSAGE, friends: [{ steamId: pinnedId, status: 3 }] });
      await getFriends(owner, deps);
      expect(steam.count('GetFriendList')).toBe(1);
      expect(steam.count('GetPlayerSummaries')).toBe(1);
    });

    it('fetches only the summary of a newly pinned player and keeps the snapshot age', async () => {
      const steam = steamWorld({ friendLists: { [owner]: { status: 401 } }, players: { [pinnedId]: player(pinnedId), [idOf(52)]: player(idOf(52)) } });
      const { store, state } = memoryStore();
      state.pinned.set(owner, [pinnedId]);
      let now = NOW;
      const deps = { store, client: steam.client, now: () => now };
      await getFriends(owner, deps);
      now += 60_000;
      state.pinned.set(owner, [pinnedId, idOf(52)]);
      const result = await getFriends(owner, deps);
      expect(result.friends.map(friend => friend.steamId)).toEqual([pinnedId, idOf(52)]);
      expect(steam.count('GetFriendList')).toBe(1);
      expect(steam.calls.filter(url => url.pathname.includes('GetPlayerSummaries')).at(-1)!.searchParams.get('steamids')).toBe(idOf(52));
      expect(state.friends.get(owner)!.fetchedAt.toMillis()).toBe(NOW);
    });

    it('drops a player that was unpinned, without a Steam call', async () => {
      const steam = steamWorld({ friendLists: { [owner]: { status: 401 } }, players: { [pinnedId]: player(pinnedId) } });
      const { store, state } = memoryStore();
      state.pinned.set(owner, [pinnedId]);
      const deps = { store, client: steam.client, now: () => NOW };
      await getFriends(owner, deps);
      await unpinPlayer(owner, pinnedId, deps);
      const calls = steam.calls.length;
      expect(await getFriends(owner, deps)).toEqual({ friends: [], message: PRIVATE_LIST_MESSAGE, source: 'friends' });
      expect(steam.calls.length).toBe(calls);
    });

    it('ignores pinned players while the friends list is public', async () => {
      const steam = publicWorld();
      const { store, state } = memoryStore();
      state.pinned.set(owner, [pinnedId]);
      const result = await getFriends(owner, { store, client: steam.client, now: () => NOW });
      expect(result.friends.map(friend => friend.steamId)).toEqual([friendA, friendB]);
    });
  });

  describe('when Steam or Firestore fail', () => {
    it('serves the stale snapshot if the refresh fails', async () => {
      const steam = steamWorld({ friendLists: { [owner]: 'fail' } });
      const { store, state } = memoryStore();
      state.friends.set(owner, { ids: [friendA], summaries: { [friendA]: { name: 'Old', url: 'u', avatar: 'a' } }, state: 'ok', fetchedAt: Timestamp.fromMillis(NOW - 2 * FRIENDS_TTL_MS) });
      const result = await getFriends(owner, { store, client: steam.client, now: () => NOW });
      expect(result.friends.map(friend => friend.personaName)).toEqual(['Old']);
    });

    it('serves the pinned players from a stale private snapshot if the refresh fails', async () => {
      const steam = steamWorld({ friendLists: { [owner]: 'fail' } });
      const { store, state } = memoryStore();
      state.pinned.set(owner, [friendA]);
      state.friends.set(owner, { ids: [friendA], summaries: { [friendA]: { name: 'Pinned', url: 'u', avatar: 'a' } }, state: 'private', fetchedAt: Timestamp.fromMillis(NOW - 2 * FRIENDS_TTL_MS) });
      const result = await getFriends(owner, { store, client: steam.client, now: () => NOW });
      expect(result).toMatchObject({ source: 'pinned', message: PINNED_MESSAGE });
      expect(result.friends.map(friend => friend.personaName)).toEqual(['Pinned']);
    });

    it('throws when there is no snapshot to fall back on', async () => {
      const steam = steamWorld({ friendLists: { [owner]: 'fail' } });
      const { store } = memoryStore();
      await expect(getFriends(owner, { store, client: steam.client, now: () => NOW })).rejects.toThrow();
    });

    it('treats an unreadable snapshot as a miss and a failed write as harmless', async () => {
      const steam = publicWorld();
      const { store } = memoryStore({
        readFriends: async () => { throw new Error('firestore down'); },
        writeFriends: async () => { throw new Error('firestore down'); },
      });
      const result = await getFriends(owner, { store, client: steam.client, now: () => NOW });
      expect(result.friends).toHaveLength(2);
    });

    it('does not put the Steam key or URLs in the logs', async () => {
      const steam = steamWorld({ friendLists: { [owner]: 'fail' } });
      const { store, state } = memoryStore();
      state.friends.set(owner, { ids: [], summaries: {}, state: 'ok', fetchedAt: Timestamp.fromMillis(NOW - 2 * FRIENDS_TTL_MS) });
      await getFriends(owner, { store, client: steam.client, now: () => NOW });
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/test-key|api\.steampowered/);
    });
  });
});

describe('snapshot parsing and size limits', () => {
  it('drops malformed summaries and rejects a snapshot without a timestamp', () => {
    const fetchedAt = Timestamp.fromMillis(NOW);
    expect(parseFriendsRecord({ ids: [idOf(1), 'x'], summaries: { [idOf(1)]: { name: 'A', status: 'no' }, [idOf(2)]: 5, bad: { name: 'B' } }, state: 'ok', fetchedAt }))
      .toEqual({ ids: [idOf(1)], summaries: { [idOf(1)]: { name: 'A', url: '', avatar: '' } }, state: 'ok', fetchedAt });
    expect(parseFriendsRecord({ ids: [], summaries: {}, state: 'ok', fetchedAt: NOW })).toBeNull();
    expect(parseFriendsRecord({ ids: [], summaries: {}, state: 'error', fetchedAt })).toBeNull();
    expect(parseFriendsRecord(undefined)).toBeNull();
  });

  it('reads pinned ids defensively', () => {
    expect(parsePinnedIds({ ids: [idOf(1), idOf(1), 'x', 7] })).toEqual([idOf(1)]);
    expect(parsePinnedIds(undefined)).toEqual([]);
  });

  it('skips documents over the Firestore limits', () => {
    expect(fitsInDocument('publicLibraries/1', { games: 'x'.repeat(1000) })).toBe(true);
    expect(fitsInDocument('publicLibraries/1', { games: 'x'.repeat(1_000_000) })).toBe(false);
    // 3,000 friends with full summaries would exceed the index-entry limit even below 1 MiB.
    const summaries = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [idOf(i), { name: 'n', url: 'u', avatar: 'a', avatarMedium: 'm', status: 1, gameId: 1, game: 'g' }]));
    expect(fitsInDocument('users/1/meta/friends', { ids: [], summaries, state: 'ok' })).toBe(false);
  });
});

describe('pinned players', () => {
  const target = idOf(70);
  const world = () => steamWorld({ players: { [target]: player(target) }, vanity: { gabe: target } });

  it.each([
    ['a Steam ID', target],
    ['a profile URL', `https://steamcommunity.com/profiles/${target}`],
    ['a vanity URL', 'https://steamcommunity.com/id/gabe'],
    ['a vanity name', 'gabe'],
  ])('pins by %s', async (_, input) => {
    const steam = world();
    const { store, state } = memoryStore();
    const result = await pinPlayer(owner, input, { store, client: steam.client, now: () => NOW });
    expect(result).toMatchObject({ ok: true, player: { steamId: target, personaName: 'Player 0070' }, pinned: [target] });
    expect(state.pinned.get(owner)).toEqual([target]);
  });

  it('pinning twice keeps one entry', async () => {
    const steam = world();
    const { store, state } = memoryStore();
    await pinPlayer(owner, target, { store, client: steam.client });
    expect(await pinPlayer(owner, target, { store, client: steam.client })).toMatchObject({ ok: true, pinned: [target] });
    expect(state.pinned.get(owner)).toEqual([target]);
  });

  it.each([
    ['input that is not a profile', 'https://example.com/profile', 'invalid'],
    ['an over-long input', 'a'.repeat(201), 'invalid'],
    ['a vanity name Steam does not know', 'nobody', 'not_found'],
    ['a Steam ID with no profile', idOf(71), 'not_found'],
    ['the user themselves', owner, 'self'],
  ])('refuses %s', async (_, input, reason) => {
    const steam = steamWorld({ players: { [owner]: player(owner) } });
    const { store, state } = memoryStore();
    expect(await pinPlayer(owner, input, { store, client: steam.client })).toEqual({ ok: false, reason });
    expect(state.pinned.has(owner)).toBe(false);
  });

  it('stops at the pin limit', async () => {
    const steam = world();
    const { store, state } = memoryStore();
    state.pinned.set(owner, Array.from({ length: MAX_PINNED }, (_, i) => idOf(200 + i)));
    expect(await pinPlayer(owner, target, { store, client: steam.client })).toEqual({ ok: false, reason: 'limit' });
    expect(state.pinned.get(owner)).toHaveLength(MAX_PINNED);
  });

  it('lets a Steam failure through so the route can answer 502', async () => {
    const steam = steamWorld({});
    steam.fetchMock.mockRejectedValue(new TypeError('offline'));
    const { store } = memoryStore();
    await expect(pinPlayer(owner, target, { store, client: steam.client })).rejects.toThrow();
  });

  it('unpins, and ignores a player who is not pinned', async () => {
    const { store, state } = memoryStore();
    state.pinned.set(owner, [target, idOf(72)]);
    expect(await unpinPlayer(owner, target, { store })).toEqual([idOf(72)]);
    expect(await unpinPlayer(owner, target, { store })).toEqual([idOf(72)]);
  });
});

describe('getLibraryFor', () => {
  const qitUser = idOf(20);
  const publicUser = idOf(21);
  const privateProfile = idOf(22);
  const privateGames = idOf(23);
  const missing = idOf(24);
  const broken = idOf(25);
  const ownedGames = { response: { game_count: 2, games: [
    { appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 120, playtime_2weeks: 30, rtime_last_played: 1_700_000_000 },
    { appid: 730, name: 'Counter-Strike 2', img_icon_url: '', playtime_forever: 0 },
  ] } };

  const world = () => steamWorld({
    players: {
      [publicUser]: player(publicUser),
      [privateProfile]: player(privateProfile, { communityvisibilitystate: 1 }),
      [privateGames]: player(privateGames),
      [broken]: player(broken),
    },
    owned: {
      [publicUser]: { body: ownedGames },
      [privateGames]: { body: { response: {} } },
      [broken]: 'fail',
    },
  });

  it('returns a state per player, in the order asked, with QIT users from the library index', async () => {
    const steam = world();
    const { store, state } = memoryStore();
    state.qit.set(qitUser, { games: new Map<number, LibIndexEntry>([[10, { n: 'Counter-Strike', p: 5 }]]), updatedAt: NOW - 1000 });
    const ids = [publicUser, qitUser, privateProfile, privateGames, missing, broken, publicUser];
    const libraries = await getLibraryFor(ids, { store, client: steam.client, now: () => NOW });
    expect(libraries.map(library => [library.steamId, library.state, library.source])).toEqual([
      [publicUser, 'ok', 'steam'], [qitUser, 'ok', 'qit'], [privateProfile, 'private', 'steam'], [privateGames, 'private', 'steam'],
      [missing, 'not_found', 'steam'], [broken, 'error', 'steam'],
    ]);
    expect(libraries[1]).toMatchObject({ fetchedAt: NOW - 1000, games: new Map([[10, { n: 'Counter-Strike', p: 5 }]]) });
    expect(libraries[0].games.get(620)).toEqual({ n: 'Portal 2', i: 'abc', p: 120, w: 30, r: 1_700_000_000 });
    expect(libraries[0].games.get(730)).toEqual({ n: 'Counter-Strike 2', p: 0, w: 0 });
    for (const library of libraries.filter(library => library.state !== 'ok')) expect(library.games.size).toBe(0);
    // A private profile is not asked for its games; a QIT user costs no Steam call at all.
    expect(steam.calls.some(url => url.searchParams.get('steamid') === privateProfile)).toBe(false);
    expect(steam.calls.some(url => url.searchParams.get('steamid') === qitUser || url.searchParams.get('steamids') === qitUser)).toBe(false);
  });

  it('refreshes a QIT index older than 30 minutes from Steam', async () => {
    const steam = world();
    const { store, state } = memoryStore();
    state.qit.set(publicUser, { games: new Map<number, LibIndexEntry>([[10, { n: 'Counter-Strike' }]]), updatedAt: NOW - QIT_INDEX_MAX_AGE_MS - 1 });
    const [library] = await getLibraryFor([publicUser], { store, client: steam.client, now: () => NOW });
    expect(library).toMatchObject({ state: 'ok', source: 'steam' });
    expect([...library.games.keys()]).toEqual([620, 730]);
    expect(state.notPublic.has(publicUser)).toBe(false);
  });

  it.each([
    ['private', privateGames],
    ['not_found', missing],
    ['error', broken],
  ] as const)('leaves out a stale QIT user whose refresh is %s, and stops reusing their index', async (expected, id) => {
    const steam = world();
    const { store, state } = memoryStore();
    state.qit.set(id, { games: new Map<number, LibIndexEntry>([[10, { n: 'Counter-Strike' }]]), updatedAt: NOW - QIT_INDEX_MAX_AGE_MS - 1 });
    const [library] = await getLibraryFor([id], { store, client: steam.client, now: () => NOW });
    expect(library).toMatchObject({ state: expected, source: 'steam' });
    expect(library.games.size).toBe(0);
    expect(state.notPublic.has(id)).toBe(true);
    expect(await store.readQitLibraries([id])).toEqual(new Map());
  });

  it('getSteamLibrary reads from Steam and never from a stored QIT index', async () => {
    const steam = world();
    const { store, state } = memoryStore();
    state.qit.set(privateGames, { games: new Map<number, LibIndexEntry>([[10, { n: 'Counter-Strike' }]]), updatedAt: NOW });
    state.qit.set(publicUser, { games: new Map<number, LibIndexEntry>([[10, { n: 'Counter-Strike' }]]), updatedAt: NOW });
    const deps = { store, client: steam.client, now: () => NOW };
    expect(await getSteamLibrary(privateGames, deps)).toMatchObject({ state: 'private', source: 'steam' });
    const library = await getSteamLibrary(publicUser, deps);
    expect(library).toMatchObject({ state: 'ok', source: 'steam' });
    expect([...library.games.keys()]).toEqual([620, 730]);
    await expect(getSteamLibrary('123', deps)).rejects.toThrow('Invalid Steam ID');
  });

  it('caches a Steam library for 30 minutes and serves it without calling Steam', async () => {
    const steam = world();
    const { store } = memoryStore();
    let now = NOW;
    const deps = { store, client: steam.client, now: () => now };
    const [first] = await getLibraryFor([publicUser], deps);
    const fetches = steam.fetchMock.mock.calls.length;
    now += PUBLIC_LIBRARY_TTL_MS - 1;
    const [second] = await getLibraryFor([publicUser], deps);
    expect(steam.fetchMock.mock.calls.length).toBe(fetches);
    expect(second).toMatchObject({ state: 'ok', source: 'steam', fetchedAt: NOW });
    expect(second.games).toEqual(first.games);
    now += 1;
    await getLibraryFor([publicUser], deps);
    expect(steam.fetchMock.mock.calls.length).toBeGreaterThan(fetches);
  });

  it('remembers private, missing and failed players for shorter times', async () => {
    const steam = world();
    const { store, state } = memoryStore();
    await getLibraryFor([privateProfile, missing, broken], { store, client: steam.client, now: () => NOW });
    const ttl = (id: string) => state.libraries.get(id)!.expiresAt.toMillis() - NOW;
    expect([ttl(privateProfile), ttl(missing), ttl(broken)]).toEqual([NEGATIVE_TTL_MS, NEGATIVE_TTL_MS, ERROR_TTL_MS]);
    expect(state.libraries.get(privateProfile)!.games).toBe('');
  });

  it('ignores an expired or unreadable cache entry', async () => {
    const steam = world();
    const { store, state } = memoryStore();
    const stamp = (ms: number) => Timestamp.fromMillis(ms);
    state.libraries.set(publicUser, { state: 'ok', games: encodeGames(new Map([[1, { n: 'Old' }]])), fetchedAt: stamp(NOW - 3_600_000), expiresAt: stamp(NOW - 1) });
    state.libraries.set(privateGames, { state: 'ok', games: 'not json', fetchedAt: stamp(NOW), expiresAt: stamp(NOW + 60_000) });
    const [fresh, corrupt] = await getLibraryFor([publicUser, privateGames], { store, client: steam.client, now: () => NOW });
    expect(fresh.games.has(620)).toBe(true);
    expect(corrupt.state).toBe('private');
  });

  it('shares one live fetch between concurrent calls', async () => {
    const steam = world();
    const { store } = memoryStore();
    const deps = { store, client: steam.client, now: () => NOW };
    await Promise.all([getLibraryFor([publicUser], deps), getLibraryFor([publicUser], deps)]);
    expect(steam.count('GetOwnedGames')).toBe(1);
  });

  it('still answers when the cache is unavailable', async () => {
    const steam = world();
    const { store } = memoryStore({
      readQitLibraries: async () => { throw new Error('down'); },
      readPublicLibraries: async () => { throw new Error('down'); },
      writePublicLibrary: async () => { throw new Error('down'); },
    });
    const [library] = await getLibraryFor([publicUser], { store, client: steam.client, now: () => NOW });
    expect(library.state).toBe('ok');
  });

  it('treats a Steam 404 as not found', async () => {
    const steam = steamWorld({ players: { [publicUser]: player(publicUser) }, owned: { [publicUser]: { status: 404, body: {} } } });
    const { store } = memoryStore();
    expect((await getLibraryFor([publicUser], { store, client: steam.client }))[0].state).toBe('not_found');
  });

  it('validates the ids', async () => {
    const { store } = memoryStore();
    await expect(getLibraryFor(['123'], { store })).rejects.toThrow('Invalid Steam ID');
    await expect(getLibraryFor(Array.from({ length: MAX_LIBRARY_IDS + 1 }, (_, i) => idOf(i)), { store })).rejects.toThrow(RangeError);
    expect(await getLibraryFor([], { store })).toEqual([]);
  });
});

describe('cached library encoding', () => {
  it('round-trips a library', () => {
    const games = new Map<number, LibIndexEntry>([
      [620, { n: 'Portal 2', i: 'abc', p: 120, w: 0, r: 1_700_000_000 }],
      [10, { n: 'Counter-Strike', p: 0, w: 0 }],
      [7, { n: '', p: 5, w: 0, r: 0 }],
    ]);
    expect(decodeGames(encodeGames(games))).toEqual(games);
  });

  it('rejects text that is not a game list and skips malformed rows', () => {
    expect(decodeGames('{')).toBeNull();
    expect(decodeGames('{}')).toBeNull();
    expect(decodeGames(JSON.stringify([[620, 'A', '', 1, 0, null], [-1, 'B'], 'x', [5, 7], [0, 'Z']]))).toEqual(new Map([[620, { n: 'A', p: 1, w: 0 }]]));
  });

  it('keeps an 8,000-game library well under the document limit', () => {
    const games = new Map<number, LibIndexEntry>(Array.from({ length: 8000 }, (_, i) => [10 * (i + 1), { n: `A fairly long game title number ${i}`, i: 'a'.repeat(40), p: 1234, w: 0, r: 1_700_000_000 }]));
    expect(fitsInDocument('publicLibraries/76561198000000000', { state: 'ok', games: encodeGames(games), fetchedAt: Timestamp.now(), expiresAt: Timestamp.now() })).toBe(true);
  });
});
