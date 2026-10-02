import { describe, expect, it } from 'vitest';
import {
  atLeastOneNeverPlayed, compareLibraries, everyoneUnderHours, groupReasons, intersect,
  nobodyPlayed, veteranWithNewcomers, type GroupLibrary,
} from '../src/lib/group';
import { renderReasons } from '../src/lib/roulette/reasons';
import type { GroupSignals } from '../src/lib/roulette/types';
import type { LibIndexEntry } from '../src/lib/store/types';

const NOW = 1_800_000_000;
const DAY = 86400;
const lib = (steamId: string, entries: [number, LibIndexEntry][] = [], playtimeHidden = false): GroupLibrary =>
  ({ steamId, games: new Map(entries), playtimeHidden });
const entry = (p?: number, extra: Partial<LibIndexEntry> = {}): LibIndexEntry => ({ n: 'Game', p, ...extra });
const ids = (games: { appid: number }[]) => games.map(game => game.appid);
const group = (...playtimes: (number | null)[]): GroupSignals => ({
  members: playtimes.map((playtimeForever, i) => ({ steamId: String(i), owns: true, playtimeForever })),
});

describe('intersect', () => {
  it('keeps only shared games, sorted, with every player and playtime classification', () => {
    const libraries = [
      lib('a', [[3, entry(30)], [2, entry(0, { n: 'First name', i: 'icon' })], [1, entry(0)]]),
      lib('b', [[2, entry(45)], [3, entry(0)], [4, entry(0)]]),
      lib('c', [[2, entry(0)]]),
      lib('d', [[2, entry(0)]] , true),
    ];
    const before = libraries.map(library => [...library.games]);
    const result = intersect(libraries);
    expect(ids(result)).toEqual([2]);
    expect(result[0]).toMatchObject({
      name: 'First name', iconHash: 'icon', owners: ['a', 'b', 'c', 'd'],
      playtimeByPlayer: { a: 0, b: 45, c: 0, d: null },
      playedBy: ['b'], neverPlayedBy: ['a', 'c'], unknownPlaytimeBy: ['d'],
    });
    expect(result[0].group.members).toHaveLength(4);
    expect(libraries.map(library => [...library.games])).toEqual(before);
    result[0].group.members[0].playtimeForever = 99;
    expect(libraries[0].games.get(2)?.p).toBe(0);
  });

  it('handles empty, single-player, disjoint and empty-player libraries', () => {
    expect(intersect([])).toEqual([]);
    expect(intersect([lib('a')])).toEqual([]);
    const single = lib('a', [[3, entry(0)], [1, entry(10)]]);
    expect(ids(intersect([single]))).toEqual([1, 3]);
    expect(intersect([single, lib('b')])).toEqual([]);
    expect(intersect([single, lib('b', [[2, entry(0)]])])).toEqual([]);
  });

  it('keeps missing, invalid and hidden playtime unknown instead of inventing zero', () => {
    for (const p of [undefined, -1, NaN, Infinity]) {
      expect(intersect([lib('a', [[1, entry(p)]])])[0]).toMatchObject({
        playedBy: [], neverPlayedBy: [], unknownPlaytimeBy: ['a'],
      });
    }
    const hidden = intersect([lib('a', [[1, entry(300, { w: 20, r: NOW })]], true)])[0];
    expect(hidden.group.members[0]).toMatchObject({ playtimeForever: null, playtime2Weeks: null, lastPlayedAt: null });
  });

  it('rejects duplicate players and unavailable libraries rather than dropping selected players', () => {
    expect(() => intersect([lib('a'), lib('a')])).toThrow(/distinct/);
    expect(() => intersect([lib('')])).toThrow(/nonempty/);
    for (const state of ['private', 'not_found', 'error'] as const) {
      expect(() => intersect([{ ...lib('a'), state }])).toThrow(/unavailable/);
    }
  });
});

describe('compareLibraries', () => {
  it('partitions ownership and returns overlapping shared-game subsets', () => {
    const a = lib('a', [[1, entry(0)], [2, entry(0)], [3, entry(20, { r: NOW - 91 * DAY })], [4, entry(30, { r: NOW })]]);
    const b = lib('b', [[2, entry(10, { r: NOW - 100 * DAY })], [3, entry(60, { r: NOW - 200 * DAY })], [4, entry(0)], [5, entry(0)]]);
    const compared = compareLibraries(a, b, { now: NOW });
    expect(ids(compared.both)).toEqual([2, 3, 4]);
    expect(ids(compared.onlyA)).toEqual([1]);
    expect(ids(compared.onlyB)).toEqual([5]);
    expect(ids(compared.neitherRecentlyPlayed)).toEqual([2, 3]);
    expect(ids(compared.oneNeverPlayed)).toEqual([2, 4]);
    expect(compared.onlyA[0].group.members[1]).toMatchObject({ owns: false, playtimeForever: null });
    expect(compared.onlyA[0].neverPlayedBy).toEqual(['a']);
  });

  it('uses shared recency semantics, exact boundaries, and a tunable window', () => {
    const a = lib('a', [
      [1, entry(20, { r: NOW - 90 * DAY })],
      [2, entry(20, { r: NOW - 91 * DAY, w: 10 })],
      [3, entry(20, { r: 0 })],
      [4, entry(0)], [5, entry(20, { w: 0 })],
    ]);
    const b = lib('b', [...a.games].map(([id]) => [id, entry(0)]));
    expect(ids(compareLibraries(a, b, { now: NOW }).neitherRecentlyPlayed)).toEqual([4]);
    expect(ids(compareLibraries(a, b, { now: NOW, notRecentlyPlayedDays: 7 }).neitherRecentlyPlayed)).toEqual([1, 2, 4, 5]);
  });

  it('does not claim hidden or missing playtime is idle or never played', () => {
    const a = lib('a', [[1, entry(0)], [2, entry(10, { r: NOW - 200 * DAY })]], true);
    const b = lib('b', [[1, entry(10)], [2, entry(0)]]);
    const compared = compareLibraries(a, b, { now: NOW });
    expect(ids(compared.oneNeverPlayed)).toEqual([2]);
    expect(compared.neitherRecentlyPlayed).toEqual([]);
    const missing = compareLibraries(lib('a', [[1, entry()]]), lib('b', [[1, entry(10)]]), { now: NOW });
    expect(missing.oneNeverPlayed).toEqual([]);
    expect(missing.neitherRecentlyPlayed).toEqual([]);
  });

  it('handles empty libraries and both-never-played games', () => {
    expect(compareLibraries(lib('a'), lib('b'), { now: NOW })).toEqual({
      both: [], onlyA: [], onlyB: [], neitherRecentlyPlayed: [], oneNeverPlayed: [],
    });
    expect(ids(compareLibraries(lib('a', [[1, entry(0)]]), lib('b'), { now: NOW }).onlyA)).toEqual([1]);
    const both = compareLibraries(lib('a', [[1, entry(0)]]), lib('b', [[1, entry(0)]]), { now: NOW });
    expect(ids(both.oneNeverPlayed)).toEqual([1]);
    expect(ids(both.neitherRecentlyPlayed)).toEqual([1]);
  });

  it('validates the comparison context', () => {
    for (const options of [{ now: NaN }, { now: -1 }, { now: NOW, notRecentlyPlayedDays: 0 }]) {
      expect(() => compareLibraries(lib('a'), lib('b'), options)).toThrow(RangeError);
    }
  });
});

describe('feature 15 group filters', () => {
  it('nobodyPlayed requires every player to have zero playtime', () => {
    expect(nobodyPlayed(group(0, 0, 0))).toBe(true);
    expect(nobodyPlayed(group(0, 1))).toBe(false);
    expect(nobodyPlayed(group(0, null))).toBe(false);
  });
  it('atLeastOneNeverPlayed requires at least one known zero', () => {
    expect(atLeastOneNeverPlayed(group(20, 0))).toBe(true);
    expect(atLeastOneNeverPlayed(group(null, 0))).toBe(true);
    expect(atLeastOneNeverPlayed(group(20, null))).toBe(false);
  });
  it('everyoneUnderHours compares minutes strictly below the supplied hours', () => {
    expect(everyoneUnderHours(group(0, 119), 2)).toBe(true);
    expect(everyoneUnderHours(group(0, 120), 2)).toBe(false);
    expect(everyoneUnderHours(group(0, null), 2)).toBe(false);
    expect(everyoneUnderHours(group(29), 0.5)).toBe(true);
  });
  it('veteranWithNewcomers requires one veteran and every other player never played', () => {
    expect(veteranWithNewcomers(group(600, 0, 0))).toBe(true);
    expect(veteranWithNewcomers(group(0, 600))).toBe(true);
    for (const g of [group(599, 0), group(600, 600, 0), group(600, 1), group(600, null), group(null, 0)]) {
      expect(veteranWithNewcomers(g)).toBe(false);
    }
    expect(veteranWithNewcomers(group(120, 0), 2)).toBe(true);
  });
  it('handles empty, single-player and non-shared groups', () => {
    const filters = [nobodyPlayed, atLeastOneNeverPlayed, (g: GroupSignals) => everyoneUnderHours(g, 2), veteranWithNewcomers];
    for (const filter of filters) {
      expect(filter(group())).toBe(false);
      expect(filter({ members: [{ steamId: 'a', owns: false, playtimeForever: 0 }] })).toBe(false);
    }
    expect(nobodyPlayed(group(0))).toBe(true);
    expect(atLeastOneNeverPlayed(group(0))).toBe(true);
    expect(everyoneUnderHours(group(0), 2)).toBe(true);
    expect(veteranWithNewcomers(group(600))).toBe(false);
  });
  it('validates hour parameters and treats invalid playtime as unknown', () => {
    for (const hours of [-1, 0, NaN, Infinity, Number.MAX_VALUE]) {
      expect(() => everyoneUnderHours(group(0), hours)).toThrow(RangeError);
      expect(() => veteranWithNewcomers(group(0), hours)).toThrow(RangeError);
    }
    for (const p of [-1, NaN, Infinity]) {
      expect(everyoneUnderHours(group(p), 2)).toBe(false);
      expect(veteranWithNewcomers(group(p, 0))).toBe(false);
    }
  });
});

describe('groupReasons', () => {
  it('uses the structured model and existing renderer for group reason strings', () => {
    const reasons = groupReasons(group(0, 0, 100, null));
    expect(reasons).toEqual([
      { code: 'friends_all_own', params: { count: 4 } },
      { code: 'friends_never_played', params: { count: 2 } },
    ]);
    expect(renderReasons(reasons)).toEqual(['All 4 players own it', '2 players have never played it']);
  });
  it('renders singular and pair reasons and emits nothing for empty groups', () => {
    expect(groupReasons(group())).toEqual([]);
    expect(renderReasons(groupReasons(group(0)))).toEqual(['1 player owns it', '1 player has never played it']);
    expect(renderReasons(groupReasons(group(10, 20)))).toEqual(['Both players own it']);
    expect(renderReasons(groupReasons(group(null)))).toEqual(['1 player owns it']);
  });
  it('never claims all own when any player does not, and counts only owners as never played', () => {
    const g = group(0, 0);
    g.members[1].owns = false;
    expect(renderReasons(groupReasons(g))).toEqual(['1 player has never played it']);
  });
});
