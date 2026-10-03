import { describe, expect, it } from 'vitest';
import { compareLibrariesService, type CompareDeps } from '../src/lib/compare/service';
import { CompareError } from '../src/lib/compare/types';
import type { GroupLibrary } from '../src/lib/group/libraries';
import type { FriendLibrary } from '../src/lib/social/libraries';
import type { PlayerSummary } from '../src/lib/steam/players';
import type { LibIndexEntry } from '../src/lib/store/types';

const userA = '76561198000000001';
const userB = '76561198000000002';
const NOW = 1_700_000_000;

function makeGame(appid: number, name: string, playtime: number, playtime2Weeks = 0, lastPlayed = NOW - 1000): [number, LibIndexEntry] {
  return [appid, { n: name, i: 'hash', p: playtime, w: playtime2Weeks, r: lastPlayed }];
}

function mockDeps(overrides: Partial<CompareDeps> = {}): CompareDeps {
  const gamesA = new Map<number, LibIndexEntry>([
    makeGame(10, 'Counter-Strike', 1200, 60, NOW - 1000), // shared, both played recently
    makeGame(20, 'Team Fortress Classic', 0, 0, 0), // shared, A never played
    makeGame(30, 'Day of Defeat', 600, 0, NOW - 200 * 86400), // shared, neither played recently
    makeGame(40, 'Deathmatch Classic', 300, 0, NOW - 1000), // only A owns
  ]);

  const gamesB = new Map<number, LibIndexEntry>([
    makeGame(10, 'Counter-Strike', 3000, 120, NOW - 2000), // shared
    makeGame(20, 'Team Fortress Classic', 500, 0, NOW - 5000), // shared
    makeGame(30, 'Day of Defeat', 100, 0, NOW - 150 * 86400), // shared, both > 90d inactive
    makeGame(50, 'Half-Life: Opposing Force', 400, 0, NOW - 3000), // only B owns
  ]);

  return {
    getRequesterLibrary: async (id: string): Promise<GroupLibrary> => ({
      steamId: id,
      games: gamesA,
      playtimeHidden: false,
      state: 'ok',
    }),
    getLibraryFor: async (ids: readonly string[]): Promise<FriendLibrary[]> =>
      ids.map(id => ({
        steamId: id,
        state: 'ok',
        source: 'steam',
        games: gamesB,
        fetchedAt: NOW * 1000,
      })),
    getPlayerSummaries: async (ids: readonly string[]): Promise<Map<string, PlayerSummary>> => {
      const map = new Map<string, PlayerSummary>();
      for (const id of ids) {
        map.set(id, {
          steamid: id,
          personaname: id === userA ? 'Player A' : 'Player B',
          profileurl: `https://steamcommunity.com/profiles/${id}`,
          communityvisibilitystate: 3,
        });
      }
      return map;
    },
    getTargetPlaytimeHidden: async () => false,
    now: () => NOW,
    ...overrides,
  };
}

describe('compareLibrariesService', () => {
  it('rejects invalid target Steam ID', async () => {
    await expect(compareLibrariesService(userA, 'invalid_id')).rejects.toThrow(CompareError);
    await expect(compareLibrariesService(userA, 'invalid_id')).rejects.toThrow('Enter a valid 17-digit Steam ID');
  });

  it('rejects invalid requester Steam ID', async () => {
    await expect(compareLibrariesService('bad', userB)).rejects.toThrow(CompareError);
    await expect(compareLibrariesService('bad', userB)).rejects.toThrow('Invalid requester Steam ID');
  });

  it('rejects comparing a library with yourself', async () => {
    await expect(compareLibrariesService(userA, userA)).rejects.toThrow(CompareError);
    await expect(compareLibrariesService(userA, userA)).rejects.toThrow('Cannot compare your library with yourself');
  });

  it('throws 404 when target Steam profile is not found', async () => {
    const deps = mockDeps({
      getLibraryFor: async ids => ids.map(id => ({ steamId: id, state: 'not_found', source: 'steam', games: new Map(), fetchedAt: null })),
    });
    const promise = compareLibrariesService(userA, userB, {}, deps);
    await expect(promise).rejects.toThrow(CompareError);
    await expect(promise).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('throws 403 when target Steam profile is private', async () => {
    const deps = mockDeps({
      getLibraryFor: async ids => ids.map(id => ({ steamId: id, state: 'private', source: 'steam', games: new Map(), fetchedAt: null })),
    });
    const promise = compareLibrariesService(userA, userB, {}, deps);
    await expect(promise).rejects.toThrow(CompareError);
    await expect(promise).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('throws 502 when target Steam library fetch encounters an error', async () => {
    const deps = mockDeps({
      getLibraryFor: async ids => ids.map(id => ({ steamId: id, state: 'error', source: 'steam', games: new Map(), fetchedAt: null })),
    });
    const promise = compareLibrariesService(userA, userB, {}, deps);
    await expect(promise).rejects.toThrow(CompareError);
    await expect(promise).rejects.toMatchObject({ code: 'unavailable', status: 502 });
  });

  it('successfully computes library comparison with shared, exclusive, and inactive games', async () => {
    const deps = mockDeps();
    const result = await compareLibrariesService(userA, userB, {}, deps);

    expect(result.target.steamId).toBe(userB);
    expect(result.target.personaName).toBe('Player B');
    expect(result.user.steamId).toBe(userA);
    expect(result.user.personaName).toBe('Player A');

    // Shared games: appids 10, 20, 30
    expect(result.sharedCount).toBe(3);
    expect(result.both.map(g => g.appid)).toEqual([10, 20, 30]);

    // Only User A owns: appid 40
    expect(result.onlyMe.map(g => g.appid)).toEqual([40]);
    expect(result.onlyA.map(g => g.appid)).toEqual([40]);

    // Only User B owns: appid 50
    expect(result.onlyThem.map(g => g.appid)).toEqual([50]);
    expect(result.onlyB.map(g => g.appid)).toEqual([50]);

    // One never played: appid 20 (User A has 0 minutes)
    expect(result.oneNeverPlayed.map(g => g.appid)).toEqual([20]);
    expect(result.oneNeverPlayed[0].neverPlayedBy).toEqual([userA]);

    // Neither recently played (90 days): appid 30 (A: 200d ago, B: 150d ago)
    expect(result.neitherRecentlyPlayed.map(g => g.appid)).toEqual([30]);

    // Playtimes are present for both players (Decision D10)
    const cs = result.both.find(g => g.appid === 10)!;
    expect(cs.playtimeByPlayer[userA]).toBe(1200);
    expect(cs.playtimeByPlayer[userB]).toBe(3000);
  });

  it('handles hidden playtime flag for either player', async () => {
    const deps = mockDeps({
      getRequesterLibrary: async id => ({
        steamId: id,
        games: new Map([makeGame(10, 'Game 10', 100)]),
        playtimeHidden: true,
        state: 'ok',
      }),
      getTargetPlaytimeHidden: async () => true,
    });

    const result = await compareLibrariesService(userA, userB, {}, deps);
    expect(result.playtimeHidden.me).toBe(true);
    expect(result.playtimeHidden.them).toBe(true);

    const game = result.both.find(g => g.appid === 10)!;
    expect(game.playtimeByPlayer[userA]).toBeNull();
  });

  it('handles empty libraries without crashing', async () => {
    const deps = mockDeps({
      getRequesterLibrary: async id => ({
        steamId: id,
        games: new Map(),
        playtimeHidden: false,
        state: 'ok',
      }),
      getLibraryFor: async ids => ids.map(id => ({
        steamId: id,
        state: 'ok',
        source: 'steam',
        games: new Map(),
        fetchedAt: NOW * 1000,
      })),
    });

    const result = await compareLibrariesService(userA, userB, {}, deps);
    expect(result.sharedCount).toBe(0);
    expect(result.both).toHaveLength(0);
    expect(result.onlyMe).toHaveLength(0);
    expect(result.onlyThem).toHaveLength(0);
    expect(result.oneNeverPlayed).toHaveLength(0);
    expect(result.neitherRecentlyPlayed).toHaveLength(0);
  });
});
