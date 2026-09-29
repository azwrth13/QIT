import { describe, expect, it } from 'vitest';
import type {
  ActivityBand, Candidate, FilterContext, FilterId, FilterSelection, FilterVerdict, HistorySignals, LibrarySignals,
  LiveSignals, Scope, Signals, StoreFlag, StoreSignals,
} from '../src/lib/roulette/types';
import { FILTER_IDS } from '../src/lib/roulette/types';
import { THRESHOLDS } from '../src/lib/roulette/thresholds';
import { getFilter } from '../src/lib/roulette/filters';
import { playedWithin } from '../src/lib/roulette/filters/recency';
import {
  MAX_FILTERS, applyPool, parseFilterSelections, poolPreview, requiredFamilies, type ParsedFilter,
} from '../src/lib/roulette/filter-engine';
import { applyExclusions, exclusionRequires, isNonGameType } from '../src/lib/roulette/exclusions';

const NOW = 1_790_000_000;
const DAY = 86_400;
const ctx = (scope: Scope = { kind: 'library' }): FilterContext => ({ now: NOW, thresholds: THRESHOLDS, scope });
const friend = (n: number) => `7656119800000${String(n).padStart(4, '0')}`;

const library = (over: Partial<LibrarySignals> = {}): LibrarySignals => ({
  name: 'Game', iconHash: null, playtimeForever: 300, playtime2Weeks: null, lastPlayedAt: null, ...over,
});
const store = (flags: Partial<Record<StoreFlag, boolean | null>> = {}, type: string | null = 'game'): StoreSignals => ({
  type,
  flags: { multiplayer: null, coop: null, singlePlayer: null, pvp: null, mmo: null, achievements: null, ...flags },
  releasedAt: null, tagIds: [], headerArt: null,
});
const cand = (appid: number, signals: Partial<Signals> = {}, lib: Partial<LibrarySignals> = {}): Candidate =>
  ({ appid, signals: { library: library(lib), ...signals } });
const live = (players: number | null, band: ActivityBand | null): LiveSignals => ({ players, band });
const history = (over: Partial<HistorySignals> = {}): HistorySignals =>
  ({ timesRolled: 0, lastRolledAt: null, excluded: null, playedAfterRoll: false, ...over });

function run(id: FilterId, candidate: Candidate, params?: unknown, scope?: Scope): FilterVerdict {
  const filter = getFilter(id);
  const parsed = filter.parse(params);
  if (parsed === null) throw new Error(`params rejected: ${JSON.stringify(params)}`);
  return filter.test(candidate, parsed, ctx(scope));
}

describe('registry', () => {
  it('has a real filter for every id, with no installed filter', () => {
    for (const id of FILTER_IDS) {
      const filter = getFilter(id);
      expect(filter).toMatchObject({ id, stub: false });
      expect(filter.requires.length).toBeGreaterThan(0);
    }
    expect(FILTER_IDS).toHaveLength(11);
    expect(FILTER_IDS as readonly string[]).not.toContain('installed');
  });

  it('declares the signal families each filter needs', () => {
    const requires = Object.fromEntries(FILTER_IDS.map(id => [id, getFilter(id).requires]));
    expect(requires).toEqual({
      'multiplayer': ['store'], 'co-op': ['store'], 'single-player': ['store'], 'achievements': ['store'],
      'never-played': ['library'], 'playtime': ['library'], 'recently-played': ['library'],
      'not-recently-played': ['library'], 'player-activity': ['live'], 'shared-with-friends': ['group'],
      'exclude-rolled': ['history'],
    });
  });
});

describe('store flag filters', () => {
  it('pass, fail and report unknown for multiplayer', () => {
    expect(run('multiplayer', cand(1, { store: store({ multiplayer: true }) }))).toBe('pass');
    expect(run('multiplayer', cand(1, { store: store({ coop: true }) }))).toBe('pass');
    expect(run('multiplayer', cand(1, { store: store({ pvp: true }) }))).toBe('pass');
    expect(run('multiplayer', cand(1, { store: store({ mmo: true }) }))).toBe('pass');
    expect(run('multiplayer', cand(1, { store: store({ multiplayer: false, coop: false, pvp: false, mmo: false }) }))).toBe('fail');
    // Some categories unknown and none true: cannot tell.
    expect(run('multiplayer', cand(1, { store: store({ multiplayer: false }) }))).toBe('unknown');
    expect(run('multiplayer', cand(1))).toBe('unknown');
  });

  it('judges co-op, single-player and achievements on their own flag only', () => {
    expect(run('co-op', cand(1, { store: store({ coop: true }) }))).toBe('pass');
    expect(run('co-op', cand(1, { store: store({ coop: false, multiplayer: true }) }))).toBe('fail');
    expect(run('co-op', cand(1, { store: store({ multiplayer: true }) }))).toBe('unknown');
    expect(run('single-player', cand(1, { store: store({ singlePlayer: true }) }))).toBe('pass');
    expect(run('single-player', cand(1, { store: store({ singlePlayer: false }) }))).toBe('fail');
    expect(run('single-player', cand(1))).toBe('unknown');
    expect(run('achievements', cand(1, { store: store({ achievements: true }) }))).toBe('pass');
    expect(run('achievements', cand(1, { store: store({ achievements: false }) }))).toBe('fail');
    expect(run('achievements', cand(1, { store: store() }))).toBe('unknown');
  });

  it('take no params', () => {
    for (const id of ['multiplayer', 'co-op', 'single-player', 'achievements', 'never-played'] as const) {
      const filter = getFilter(id);
      expect(filter.parse(undefined)).toEqual({});
      expect(filter.parse(null)).toEqual({});
      expect(filter.parse({})).toEqual({});
      expect(filter.parse({ extra: 1 })).toBeNull();
      expect(filter.parse('yes')).toBeNull();
      expect(filter.parse([])).toBeNull();
    }
  });
});

describe('never-played and playtime', () => {
  it('never-played passes only at zero minutes', () => {
    expect(run('never-played', cand(1, {}, { playtimeForever: 0 }))).toBe('pass');
    expect(run('never-played', cand(1, {}, { playtimeForever: 1 }))).toBe('fail');
  });

  it('playtime is inclusive at both ends', () => {
    const at = (minutes: number) => cand(1, {}, { playtimeForever: minutes });
    expect(run('playtime', at(59), { minMinutes: 60, maxMinutes: 120 })).toBe('fail');
    expect(run('playtime', at(60), { minMinutes: 60, maxMinutes: 120 })).toBe('pass');
    expect(run('playtime', at(120), { minMinutes: 60, maxMinutes: 120 })).toBe('pass');
    expect(run('playtime', at(121), { minMinutes: 60, maxMinutes: 120 })).toBe('fail');
    expect(run('playtime', at(5000), { minMinutes: 60 })).toBe('pass');
    expect(run('playtime', at(0), { maxMinutes: 0 })).toBe('pass');
    expect(run('playtime', at(1), { maxMinutes: 0 })).toBe('fail');
  });

  it('playtime rejects empty, inverted, fractional, negative and unknown params', () => {
    const filter = getFilter('playtime');
    expect(filter.parse(undefined)).toBeNull();
    expect(filter.parse({})).toBeNull();
    expect(filter.parse({ minMinutes: 10, maxMinutes: 5 })).toBeNull();
    expect(filter.parse({ minMinutes: 1.5 })).toBeNull();
    expect(filter.parse({ minMinutes: -1 })).toBeNull();
    expect(filter.parse({ minMinutes: '10' })).toBeNull();
    expect(filter.parse({ minMinutes: Number.NaN })).toBeNull();
    expect(filter.parse({ minMinutes: 1e12 })).toBeNull();
    expect(filter.parse({ minMinutes: 10, hours: 1 })).toBeNull();
    expect(filter.parse({ minMinutes: 10, maxMinutes: 10 })).toEqual({ minMinutes: 10, maxMinutes: 10 });
  });
});

describe('recency filters', () => {
  it('classify by last played time', () => {
    const played = (daysAgo: number, extra: Partial<LibrarySignals> = {}) =>
      cand(1, {}, { lastPlayedAt: NOW - daysAgo * DAY, ...extra });
    expect(run('recently-played', played(29))).toBe('pass');
    expect(run('recently-played', played(30))).toBe('pass');
    expect(run('recently-played', played(31))).toBe('fail');
    expect(run('recently-played', played(31), { days: 60 })).toBe('pass');
    expect(run('not-recently-played', played(89))).toBe('fail');
    expect(run('not-recently-played', played(91))).toBe('pass');
    expect(run('not-recently-played', played(91), { days: 120 })).toBe('fail');
  });

  it('read a never-played game as not recently played', () => {
    const never = cand(1, {}, { playtimeForever: 0 });
    expect(run('recently-played', never)).toBe('fail');
    expect(run('not-recently-played', never)).toBe('pass');
  });

  it('treat a missing last-played time as unknown, unless the two-week playtime settles it', () => {
    const unknownTime = cand(1, {}, { playtimeForever: 500, lastPlayedAt: null, playtime2Weeks: null });
    expect(run('recently-played', unknownTime)).toBe('unknown');
    expect(run('not-recently-played', unknownTime)).toBe('unknown');
    // Played in the last 14 days, so within any window of 14 days or more even without a timestamp.
    const active = cand(1, {}, { playtimeForever: 500, lastPlayedAt: null, playtime2Weeks: 30 });
    expect(run('recently-played', active)).toBe('pass');
    expect(run('not-recently-played', active)).toBe('fail');
    expect(run('recently-played', active, { days: 7 })).toBe('unknown');
    // No play in 14 days settles a window of 14 days or less.
    const idle = cand(1, {}, { playtimeForever: 500, lastPlayedAt: null, playtime2Weeks: 0 });
    expect(run('recently-played', idle, { days: 7 })).toBe('fail');
    expect(run('recently-played', idle, { days: 30 })).toBe('unknown');
  });

  it('let two-week playtime override a stale last-played time', () => {
    expect(playedWithin(library({ lastPlayedAt: NOW - 400 * DAY, playtime2Weeks: 10 }), 30, NOW)).toBe('within');
  });

  it('validate the days param', () => {
    for (const id of ['recently-played', 'not-recently-played'] as const) {
      const filter = getFilter(id);
      expect(filter.parse(undefined)).toEqual({});
      expect(filter.parse({ days: 45 })).toEqual({ days: 45 });
      for (const days of [0, -1, 1.5, '30', 4000, Number.NaN, null]) expect(filter.parse({ days })).toBeNull();
      expect(filter.parse({ day: 3 })).toBeNull();
    }
  });
});

describe('player-activity', () => {
  const withLive = (players: number | null, band: ActivityBand | null) => cand(1, { live: live(players, band) });

  it('rejects a missing or unknown mode', () => {
    const filter = getFilter('player-activity');
    for (const raw of [undefined, {}, { mode: 'busy' }, { mode: 1 }, { mode: 'high', extra: true }]) {
      expect(filter.parse(raw)).toBeNull();
    }
    expect(filter.parse({ mode: 'low' })).toEqual({ mode: 'low' });
  });

  it('active means at or above the absolute floor of 100', () => {
    expect(run('player-activity', withLive(100, 'low'), { mode: 'active' })).toBe('pass');
    expect(run('player-activity', withLive(99, 'high'), { mode: 'active' })).toBe('fail');
    // The floor needs no band, so a pool too small for bands still answers.
    expect(run('player-activity', withLive(500, null), { mode: 'active' })).toBe('pass');
  });

  it('high needs the top band and the floor; low needs the bottom band', () => {
    expect(run('player-activity', withLive(5000, 'high'), { mode: 'high' })).toBe('pass');
    expect(run('player-activity', withLive(60, 'high'), { mode: 'high' })).toBe('fail');
    expect(run('player-activity', withLive(500, 'mid'), { mode: 'high' })).toBe('fail');
    expect(run('player-activity', withLive(3, 'low'), { mode: 'low' })).toBe('pass');
    expect(run('player-activity', withLive(0, 'low'), { mode: 'low' })).toBe('pass');
    expect(run('player-activity', withLive(500, 'mid'), { mode: 'low' })).toBe('fail');
  });

  it('is unknown, not zero, without a counter, a band or the live signals', () => {
    for (const mode of ['active', 'high', 'low']) {
      expect(run('player-activity', withLive(null, null), { mode })).toBe('unknown');
      expect(run('player-activity', cand(1), { mode })).toBe('unknown');
    }
    expect(run('player-activity', withLive(500, null), { mode: 'high' })).toBe('unknown');
    expect(run('player-activity', withLive(500, null), { mode: 'low' })).toBe('unknown');
  });

  it('follows the thresholds in its context', () => {
    const filter = getFilter('player-activity');
    const strict = { ...ctx(), thresholds: { ...THRESHOLDS, activeMinPlayers: 1000 } };
    expect(filter.test(withLive(500, 'high'), { mode: 'active' }, strict)).toBe('fail');
  });
});

describe('shared-with-friends', () => {
  const group = (...members: [string, boolean][]) =>
    cand(1, { group: { members: members.map(([steamId, owns]) => ({ steamId, owns, playtimeForever: null })) } });
  const [me, a, b] = [friend(1), friend(2), friend(3)];
  const friendsScope: Scope = { kind: 'friends', with: [a, b] };

  it('needs every named friend by default', () => {
    expect(run('shared-with-friends', group([me, true], [a, true], [b, true]), {}, friendsScope)).toBe('pass');
    expect(run('shared-with-friends', group([me, true], [a, true], [b, false]), {}, friendsScope)).toBe('fail');
  });

  it('takes the friends from params over the scope, and supports any', () => {
    const one = group([me, true], [a, false], [b, true]);
    expect(run('shared-with-friends', one, { with: [b] }, friendsScope)).toBe('pass');
    expect(run('shared-with-friends', one, { with: [a] }, friendsScope)).toBe('fail');
    expect(run('shared-with-friends', one, { match: 'any' }, friendsScope)).toBe('pass');
    expect(run('shared-with-friends', group([me, true], [a, false], [b, false]), { match: 'any' }, friendsScope)).toBe('fail');
  });

  it('reads a friend with no readable library as unknown unless another friend decides it', () => {
    const missing = group([me, true], [a, true]);
    expect(run('shared-with-friends', missing, {}, friendsScope)).toBe('unknown');
    expect(run('shared-with-friends', group([me, true], [a, false]), {}, friendsScope)).toBe('fail');
    expect(run('shared-with-friends', missing, { match: 'any' }, friendsScope)).toBe('pass');
    expect(run('shared-with-friends', group([me, true], [b, false]), { match: 'any' }, friendsScope)).toBe('unknown');
  });

  it('uses the pair friend, and every group member when the scope names no friends', () => {
    expect(run('shared-with-friends', group([me, true], [a, true]), {}, { kind: 'pair', with: a })).toBe('pass');
    expect(run('shared-with-friends', group([me, true], [a, false]), {}, { kind: 'pair', with: a })).toBe('fail');
    expect(run('shared-with-friends', group([me, true], [a, true]), {}, { kind: 'lobby', code: 'ABCD' })).toBe('pass');
    expect(run('shared-with-friends', group([me, true], [a, false]), {}, { kind: 'library' })).toBe('fail');
  });

  it('reads an unreadable scope member as unknown when the scope names no friends', () => {
    const lobby: Scope = { kind: 'lobby', code: 'ABCD' };
    const filter = getFilter('shared-with-friends');
    const members = { ...ctx(lobby), members: [me, a, b] };
    expect(filter.test(group([me, true], [a, true]), {}, members)).toBe('unknown');
    expect(filter.test(group([me, true], [a, false]), {}, members)).toBe('fail');
    expect(filter.test(group([me, true], [a, true]), { match: 'any' }, members)).toBe('pass');
    expect(filter.test(group([me, true], [a, true]), {}, { ...ctx({ kind: 'library' }), members: [me, a, b] })).toBe('unknown');
    expect(filter.test(group([me, true], [a, true], [b, true]), {}, members)).toBe('pass');
  });

  it('is unknown without group signals or any member', () => {
    expect(run('shared-with-friends', cand(1), {}, friendsScope)).toBe('unknown');
    expect(run('shared-with-friends', group(), {}, { kind: 'library' })).toBe('unknown');
  });

  it('validates params', () => {
    const filter = getFilter('shared-with-friends');
    expect(filter.parse(undefined)).toEqual({});
    expect(filter.parse({ with: [a, b], match: 'any' })).toEqual({ with: [a, b], match: 'any' });
    expect(filter.parse({ with: [] })).toBeNull();
    expect(filter.parse({ with: ['123'] })).toBeNull();
    expect(filter.parse({ with: [a, a] })).toBeNull();
    expect(filter.parse({ with: a })).toBeNull();
    expect(filter.parse({ with: Array.from({ length: 17 }, (_, n) => friend(n)) })).toBeNull();
    expect(filter.parse({ match: 'most' })).toBeNull();
    expect(filter.parse({ friends: [a] })).toBeNull();
  });
});

describe('exclude-rolled', () => {
  const rolled = (daysAgo: number | null, timesRolled = 1) =>
    cand(1, { history: history({ lastRolledAt: daysAgo === null ? null : NOW - daysAgo * DAY, timesRolled }) });

  it('fails games rolled inside the window, 30 days by default', () => {
    expect(run('exclude-rolled', rolled(29))).toBe('fail');
    expect(run('exclude-rolled', rolled(31))).toBe('pass');
    expect(run('exclude-rolled', rolled(8), { days: 7 })).toBe('pass');
    expect(run('exclude-rolled', rolled(6), { days: 7 })).toBe('fail');
    expect(run('exclude-rolled', rolled(60), { days: 90 })).toBe('fail');
    expect(run('exclude-rolled', cand(1, { history: history() }))).toBe('pass');
  });

  it('is off at 0 days, even without history', () => {
    expect(run('exclude-rolled', rolled(0), { days: 0 })).toBe('pass');
    expect(run('exclude-rolled', cand(1), { days: 0 })).toBe('pass');
  });

  it('is unknown without history, or a roll count with no date', () => {
    expect(run('exclude-rolled', cand(1))).toBe('unknown');
    expect(run('exclude-rolled', rolled(null, 2))).toBe('unknown');
  });

  it('validates params', () => {
    const filter = getFilter('exclude-rolled');
    expect(filter.parse(undefined)).toEqual({});
    expect(filter.parse({ days: 90 })).toEqual({ days: 90 });
    for (const days of [-1, 1.5, '7', 4000, null]) expect(filter.parse({ days })).toBeNull();
  });
});

describe('exclusion stage', () => {
  it('drops request exclusions, active vetoes and non-games, counting each', () => {
    const pool = [
      cand(1),
      cand(2),
      cand(3, { history: history({ excluded: 'session' }) }),
      cand(4, { history: history({ excluded: 'forever' }) }),
      cand(5, { store: store({}, 'software') }),
      cand(6, { store: store({}, 'DLC') }),
      cand(7, { store: store({}, 'game') }),
      cand(8, { store: store({}, null) }),
      cand(9, { history: history({ excluded: '7d' }), store: store({}, 'tool') }),
    ];
    const { kept, removed } = applyExclusions(pool, { exclude: [2] });
    expect(kept.map(c => c.appid)).toEqual([1, 7, 8]);
    // App 9 is both vetoed and a tool: counted once, as vetoed.
    expect(removed).toEqual({ request: 1, vetoed: 3, non_game: 2 });
  });

  it('keeps non-games when asked, and never excludes on unknown type', () => {
    const pool = [cand(1, { store: store({}, 'software') }), cand(2, { store: store({}, null) }), cand(3)];
    expect(applyExclusions(pool, { showNonGames: true }).kept).toHaveLength(3);
    expect(applyExclusions(pool).kept.map(c => c.appid)).toEqual([2, 3]);
    expect(isNonGameType('demo')).toBe(false);
    expect(isNonGameType(null)).toBe(false);
  });

  it('does not mutate its input and handles an empty pool', () => {
    const pool = [cand(1), cand(2)];
    applyExclusions(pool, { exclude: [1] });
    expect(pool).toHaveLength(2);
    expect(applyExclusions([]).kept).toEqual([]);
  });

  it('needs the store family only while hiding non-games', () => {
    expect(exclusionRequires()).toEqual(['history', 'store']);
    expect(exclusionRequires({ showNonGames: true })).toEqual(['history']);
  });
});

describe('parseFilterSelections', () => {
  const ok = (raw: unknown): ParsedFilter[] => {
    const result = parseFilterSelections(raw);
    if (!result.ok) throw new Error(result.error);
    return result.filters;
  };

  it('parses valid selections in order, with params', () => {
    const filters = ok([{ id: 'multiplayer' }, { id: 'playtime', params: { maxMinutes: 60 } }]);
    expect(filters.map(f => f.filter.id)).toEqual(['multiplayer', 'playtime']);
    expect(filters[1].params).toEqual({ maxMinutes: 60 });
  });

  it('treats no filters as an empty list', () => {
    expect(ok(undefined)).toEqual([]);
    expect(ok(null)).toEqual([]);
    expect(ok([])).toEqual([]);
  });

  it('rejects malformed requests', () => {
    const bad: unknown[] = [
      'multiplayer', { id: 'multiplayer' }, [null], [1], [['multiplayer']], [{}], [{ id: 'installed' }],
      [{ id: 'constructor' }], [{ id: 'toString' }], [{ id: 'playtime' }], [{ id: 'playtime', params: { minMinutes: -5 } }],
      [{ id: 'multiplayer' }, { id: 'multiplayer' }], [{ id: 'multiplayer', params: { x: 1 } }],
    ];
    for (const raw of bad) expect(parseFilterSelections(raw)).toMatchObject({ ok: false });
  });

  it('caps the number of filters', () => {
    const many: FilterSelection[] = Array.from({ length: MAX_FILTERS + 1 }, () => ({ id: 'multiplayer' as const }));
    expect(parseFilterSelections(many)).toMatchObject({ ok: false });
  });
});

describe('requiredFamilies', () => {
  const parse = (raw: unknown) => {
    const result = parseFilterSelections(raw);
    if (!result.ok) throw new Error(result.error);
    return result.filters;
  };

  it('is the union of exclusion and filter needs, in a fixed order', () => {
    expect(requiredFamilies({})).toEqual(['store', 'history']);
    expect(requiredFamilies({ exclusions: { showNonGames: true } })).toEqual(['history']);
    const filters = parse([{ id: 'shared-with-friends' }, { id: 'player-activity', params: { mode: 'high' } }, { id: 'never-played' }]);
    expect(requiredFamilies({ filters })).toEqual(['library', 'store', 'live', 'history', 'group']);
  });
});

describe('applyPool and poolPreview', () => {
  const parse = (raw: unknown) => {
    const result = parseFilterSelections(raw);
    if (!result.ok) throw new Error(result.error);
    return result.filters;
  };
  const pool = [
    cand(1, { store: store({ multiplayer: true }) }, { playtimeForever: 0 }),
    cand(2, { store: store({ multiplayer: true }) }, { playtimeForever: 600 }),
    cand(3, { store: store({ multiplayer: false, coop: false, pvp: false, mmo: false }) }, { playtimeForever: 0 }),
    cand(4, {}, { playtimeForever: 0 }),
    cand(5, { store: store({ multiplayer: true }, 'software') }, { playtimeForever: 0 }),
    cand(6, { store: store({ multiplayer: true }) }, { playtimeForever: 0 }),
  ];
  const stages = { exclusions: { exclude: [6] }, filters: parse([{ id: 'multiplayer' }, { id: 'never-played' }]) };

  it('combines filters with AND and drops unknowns by default', () => {
    const result = applyPool(pool, stages, ctx());
    expect(result.candidates.map(c => c.appid)).toEqual([1]);
    expect(result.preview).toEqual({
      total: 6,
      removed: { request: 1, vetoed: 0, non_game: 1 },
      afterExclusions: 4,
      steps: [
        { id: 'multiplayer', passed: 2, failed: 1, unknown: 1, remaining: 2 },
        { id: 'never-played', passed: 1, failed: 1, unknown: 0, remaining: 1 },
      ],
      final: 1,
    });
  });

  it('can keep games whose signals are unknown, and still counts them', () => {
    const result = applyPool(pool, { ...stages, unknown: 'include' }, ctx());
    expect(result.candidates.map(c => c.appid)).toEqual([1, 4]);
    expect(result.preview.steps[0]).toMatchObject({ unknown: 1, remaining: 3 });
  });

  it('passes the whole pool through with no stages, and leaves the input alone', () => {
    const before = [...pool];
    expect(applyPool(pool, {}, ctx()).candidates).toHaveLength(5);
    expect(applyPool([], stages, ctx()).preview).toMatchObject({ total: 0, final: 0 });
    expect(pool).toEqual(before);
  });

  it('poolPreview returns the same counts as applyPool', () => {
    expect(poolPreview(pool, stages, ctx())).toEqual(applyPool(pool, stages, ctx()).preview);
  });

  it('passes the scope through to filters', () => {
    const shared = parse([{ id: 'shared-with-friends' }]);
    const owned = cand(1, { group: { members: [{ steamId: friend(2), owns: true, playtimeForever: 0 }] } });
    const notOwned = cand(2, { group: { members: [{ steamId: friend(2), owns: false, playtimeForever: 0 }] } });
    const scope: Scope = { kind: 'pair', with: friend(2) };
    expect(applyPool([owned, notOwned], { filters: shared }, ctx(scope)).candidates.map(c => c.appid)).toEqual([1]);
  });
});
