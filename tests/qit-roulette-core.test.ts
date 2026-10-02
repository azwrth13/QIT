import { describe, expect, it } from 'vitest';
import { SCOPE_KINDS, type Candidate, type Mode, type Reason, type ScoreContext, type Scope } from '../src/lib/roulette/types';
import { THRESHOLDS } from '../src/lib/roulette/thresholds';
import { composeSeed, createRng, randomSeed, weightedSample, type Rng } from '../src/lib/roulette/sampler';
import { CARD_REASON_LIMIT, REASON_CODES, isReasonCode, orderReasons, parseReason, reason, renderReason, renderReasons } from '../src/lib/roulette/reasons';
import { ModeScopeError, drawScored, roll, scoreCandidates } from '../src/lib/roulette/scoring';
import { StubNotImplementedError } from '../src/lib/roulette/stubs';
import { getMode } from '../src/lib/roulette/modes';

const candidate = (appid: number, playtimeForever = 0): Candidate => ({
  appid,
  signals: { library: { name: `Game ${appid}`, iconHash: null, playtimeForever, playtime2Weeks: null, lastPlayedAt: null } },
});
const ctx = (scope: Scope = { kind: 'library' }, samplerGamma = THRESHOLDS.samplerGamma): ScoreContext => ({
  now: 1_790_000_000,
  thresholds: { ...THRESHOLDS, samplerGamma },
  scope,
});

// Pearson's chi-square statistic; every critical value below is the 0.1% tail for its degrees of
// freedom. Draws use fixed seeds, so these checks are deterministic rather than flaky.
function chiSquare(observed: number[], expected: number[]): number {
  return observed.reduce((sum, o, i) => sum + (o - expected[i]) ** 2 / expected[i], 0);
}
const CHI2_999 = { 1: 10.83, 3: 16.27, 4: 18.47, 5: 20.52 } as const;

function firstDrawCounts(weights: number[], gamma: number, draws: number): number[] {
  const counts = weights.map(() => 0);
  const entries = weights.map((weight, item) => ({ item, weight }));
  for (let i = 0; i < draws; i++) counts[weightedSample(entries, 1, { rng: createRng(composeSeed('dist', gamma, i)), gamma })[0]]++;
  return counts;
}

describe('seedable rng', () => {
  it('replays the same sequence for a seed (golden vector)', () => {
    const a = createRng('qit');
    expect([a(), a(), a()]).toEqual([0.26675151637755334, 0.9830948256421834, 0.7069657419342548]);
    const b = createRng('qit');
    const c = createRng('qit!');
    const seq = (rng: Rng) => Array.from({ length: 20 }, rng);
    expect(seq(b)).toEqual(seq(createRng('qit')));
    expect(seq(c)).not.toEqual(seq(createRng('qit')));
  });

  it('stays in [0, 1) and looks uniform', () => {
    const rng = createRng('uniform');
    const buckets = Array.from({ length: 10 }, () => 0);
    for (let i = 0; i < 50_000; i++) {
      const u = rng();
      expect(u >= 0 && u < 1).toBe(true);
      buckets[Math.floor(u * 10)]++;
    }
    // 9 degrees of freedom, 0.1% tail.
    expect(chiSquare(buckets, buckets.map(() => 5_000))).toBeLessThan(27.88);
  });

  it('composes seeds without ambiguity and makes fresh random seeds', () => {
    expect(composeSeed('a:b', 'c')).not.toBe(composeSeed('a', 'b:c'));
    expect(composeSeed('daily', 1)).not.toBe(composeSeed('daily', '1'));
    expect(composeSeed('x', 2)).toBe(composeSeed('x', 2));
    const seed = randomSeed();
    expect(seed).toMatch(/^[0-9a-f]{32}$/);
    expect(randomSeed()).not.toBe(seed);
  });
});

describe('weighted sampler', () => {
  const entries = [10, 20, 30, 40, 50, 60].map((appid, i) => ({ item: appid, weight: i + 1 }));
  const seed = composeSeed('daily', '76561198000000001', '2026-09-29', 'pure-random', 0);

  it('is deterministic for a seed (golden vector) and a smaller count is a prefix', () => {
    const all = weightedSample(entries, 6, { rng: createRng(seed), gamma: 1.5 });
    expect(all).toEqual([40, 30, 10, 50, 60, 20]);
    for (let count = 0; count <= 6; count++) {
      expect(weightedSample(entries, count, { rng: createRng(seed), gamma: 1.5 })).toEqual(all.slice(0, count));
    }
  });

  it('draws without replacement and stops at the pool size', () => {
    for (let i = 0; i < 200; i++) {
      const drawn = weightedSample(entries, 10, { rng: createRng(composeSeed('perm', i)), gamma: 1.5 });
      expect(drawn).toHaveLength(6);
      expect([...drawn].sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50, 60]);
    }
    expect(weightedSample([], 3, { rng: createRng('empty'), gamma: 1.5 })).toEqual([]);
  });

  it('consumes one draw per item, so the rng is left in a predictable state', () => {
    let calls = 0;
    const counting: Rng = () => { calls++; return 0.5; };
    weightedSample(entries, 1, { rng: counting, gamma: 1 });
    expect(calls).toBe(entries.length);
  });

  it('picks first in proportion to weight (gamma 1)', () => {
    const weights = [1, 2, 3, 4];
    const draws = 20_000;
    const counts = firstDrawCounts(weights, 1, draws);
    expect(chiSquare(counts, weights.map(w => (draws * w) / 10))).toBeLessThan(CHI2_999[3]);
  });

  it('picks first in proportion to weight ^ gamma (default 1.5)', () => {
    // 1 : 4 becomes 1 : 8.
    const draws = 18_000;
    const counts = firstDrawCounts([1, 4], 1.5, draws);
    expect(chiSquare(counts, [draws / 9, (draws * 8) / 9])).toBeLessThan(CHI2_999[1]);
  });

  it('treats every weight alike when gamma is 0', () => {
    const draws = 20_000;
    const counts = firstDrawCounts([1, 5, 25, 125, 625], 0, draws);
    expect(chiSquare(counts, counts.map(() => draws / 5))).toBeLessThan(CHI2_999[4]);
  });

  it('draws the second pick from the remaining weights', () => {
    // P(a then b) = w_a / S * w_b / (S - w_a) for weights 1, 2, 3.
    const weights = [1, 2, 3];
    const pairs = [[0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]];
    const draws = 30_000;
    const observed = pairs.map(() => 0);
    const pool = weights.map((weight, item) => ({ item, weight }));
    for (let i = 0; i < draws; i++) {
      const [a, b] = weightedSample(pool, 2, { rng: createRng(composeSeed('pair', i)), gamma: 1 });
      observed[pairs.findIndex(([x, y]) => x === a && y === b)]++;
    }
    const expected = pairs.map(([a, b]) => draws * (weights[a] / 6) * (weights[b] / (6 - weights[a])));
    expect(chiSquare(observed, expected)).toBeLessThan(CHI2_999[5]);
  });

  it('handles extreme weights without overflow', () => {
    const extreme = [{ item: 'tiny', weight: 1e-300 }, { item: 'huge', weight: 1e300 }];
    for (let i = 0; i < 50; i++) {
      expect(weightedSample(extreme, 2, { rng: createRng(composeSeed('extreme', i)), gamma: 3 })).toEqual(['huge', 'tiny']);
    }
  });

  it('rejects invalid weights, counts and gammas', () => {
    const rng = createRng('bad');
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => weightedSample([{ item: 1, weight }], 1, { rng, gamma: 1 })).toThrow(RangeError);
    }
    for (const count of [-1, 1.5, Number.NaN]) {
      expect(() => weightedSample(entries, count, { rng, gamma: 1 })).toThrow(RangeError);
    }
    for (const gamma of [-0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => weightedSample(entries, 1, { rng, gamma })).toThrow(RangeError);
    }
  });
});

// A test mode: weight is the playtime, 0 playtime is ineligible, and reasons come back out of order.
const byPlaytime: Mode = {
  id: 'comfort-pick',
  label: 'Test',
  description: 'Test',
  requires: ['library'],
  emits: ['comfort', 'not_rolled_recently'],
  scopes: ['library'],
  stub: false,
  score: c => ({
    eligible: c.signals.library.playtimeForever > 0,
    weight: c.signals.library.playtimeForever,
    reasons: [
      reason('not_rolled_recently', {}),
      reason('friends_all_own', { count: 3 }),
      reason('comfort', { hours: c.signals.library.playtimeForever / 60 }),
    ],
  }),
};

describe('scoring', () => {
  it('keeps eligible candidates with positive weight and orders their reasons by the mode', () => {
    const scored = scoreCandidates(byPlaytime, [candidate(1, 0), candidate(2, 120), candidate(3, 600)], ctx());
    expect(scored.map(s => [s.candidate.appid, s.weight])).toEqual([[2, 120], [3, 600]]);
    expect(scored[0].reasons.map(r => r.code)).toEqual(['comfort', 'not_rolled_recently', 'friends_all_own']);
  });

  it('drops weight 0 and throws on weights a mode must never return', () => {
    const fixed = (weight: number): Mode => ({ ...byPlaytime, score: () => ({ eligible: true, weight, reasons: [] }) });
    expect(scoreCandidates(fixed(0), [candidate(1)], ctx())).toEqual([]);
    for (const weight of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scoreCandidates(fixed(weight), [candidate(1)], ctx())).toThrow(RangeError);
    }
  });

  it('refuses stub modes and scopes the mode does not support', () => {
    expect(() => scoreCandidates(getMode('achievement-hunter'), [], ctx())).toThrow(StubNotImplementedError);
    expect(() => scoreCandidates(byPlaytime, [candidate(1, 5)], ctx({ kind: 'pair', with: '76561198000000001' }))).toThrow(ModeScopeError);
  });

  it('draws the same game for a seed however the pool is ordered', () => {
    const pool = [candidate(730, 50), candidate(570, 300), candidate(440, 20), candidate(620, 900), candidate(10, 5)];
    const scored = scoreCandidates(byPlaytime, pool, ctx());
    const reversed = scoreCandidates(byPlaytime, [...pool].reverse(), ctx());
    for (let i = 0; i < 50; i++) {
      const seed = composeSeed('order', i);
      const a = drawScored(scored, { rng: createRng(seed), gamma: 1.5, count: 3 }).map(s => s.candidate.appid);
      const b = drawScored(reversed, { rng: createRng(seed), gamma: 1.5, count: 3 }).map(s => s.candidate.appid);
      expect(b).toEqual(a);
    }
  });

  it('rejects a pool holding the same game twice', () => {
    const scored = scoreCandidates(byPlaytime, [candidate(5, 10), candidate(5, 20)], ctx());
    expect(() => drawScored(scored, { rng: createRng('dup'), gamma: 1 })).toThrow(RangeError);
  });

  it('rolls with the context gamma and reports the eligible count', () => {
    const pool = [candidate(1, 0), candidate(2, 60), candidate(3, 240)];
    const result = roll(byPlaytime, pool, ctx(), { rng: createRng('roll'), count: 5 });
    expect(result.eligible).toBe(2);
    expect(result.picks.map(p => p.candidate.appid).sort()).toEqual([2, 3]);
    expect(roll(byPlaytime, [candidate(1, 0)], ctx(), { rng: createRng('none') })).toEqual({ picks: [], eligible: 0 });

    // Gamma comes from ctx.thresholds: 60 : 240 is 1 : 4 at gamma 1, and 1 : 1 at gamma 0.
    const firstShare = (gamma: number) => {
      let hits = 0;
      for (let i = 0; i < 10_000; i++) {
        if (roll(byPlaytime, pool, ctx({ kind: 'library' }, gamma), { rng: createRng(composeSeed('gamma', i)) }).picks[0].candidate.appid === 3) hits++;
      }
      return hits / 10_000;
    };
    expect(firstShare(1)).toBeCloseTo(0.8, 1);
    expect(firstShare(0)).toBeCloseTo(0.5, 1);
  });
});

describe('pure random mode', () => {
  const mode = getMode('pure-random');

  it('is implemented, needs only the library and works in every scope', () => {
    expect(mode).toMatchObject({ id: 'pure-random', stub: false, requires: ['library'], emits: ['random_pick'] });
    expect(mode.scopes).toEqual([...SCOPE_KINDS]);
    const scopes: Scope[] = [
      { kind: 'library' },
      { kind: 'friends', with: ['76561198000000001'] },
      { kind: 'pair', with: '76561198000000001' },
      { kind: 'lobby', code: 'ABC234' },
      { kind: 'appids', appids: [1, 2] },
    ];
    for (const scope of scopes) expect(scoreCandidates(mode, [candidate(1), candidate(2)], ctx(scope))).toHaveLength(2);
  });

  it('gives every game weight 1 and the random-pick reason, whatever its signals', () => {
    for (const c of [candidate(1, 0), candidate(2, 99_999)]) {
      expect(mode.score(c, ctx())).toEqual({ eligible: true, weight: 1, reasons: [{ code: 'random_pick', params: {} }] });
    }
    expect(renderReasons(scoreCandidates(mode, [candidate(1)], ctx())[0].reasons)).toEqual(['Picked completely at random']);
  });

  it('picks uniformly at the default gamma', () => {
    const pool = [candidate(10, 0), candidate(20, 5), candidate(30, 50_000), candidate(40, 60), candidate(50, 1)];
    const counts = new Map<number, number>();
    const draws = 20_000;
    for (let i = 0; i < draws; i++) {
      const [pick] = roll(mode, pool, ctx(), { rng: createRng(composeSeed('pure', i)) }).picks;
      counts.set(pick.candidate.appid, (counts.get(pick.candidate.appid) ?? 0) + 1);
    }
    const observed = pool.map(c => counts.get(c.appid) ?? 0);
    expect(chiSquare(observed, observed.map(() => draws / 5))).toBeLessThan(CHI2_999[4]);
  });

  it('never repeats a game within one multi-pick roll', () => {
    const pool = Array.from({ length: 30 }, (_, i) => candidate(i + 1));
    const picks = roll(mode, pool, ctx(), { rng: createRng('rerolls'), count: 30 }).picks.map(p => p.candidate.appid);
    expect(new Set(picks).size).toBe(30);
  });
});

describe('reasons', () => {
  const examples: Reason[] = [
    reason('random_pick', {}),
    reason('never_launched', {}),
    reason('barely_played', { minutes: 45 }),
    reason('idle', { months: 14 }),
    reason('outside_rotation', {}),
    reason('comfort', { hours: 212.4 }),
    reason('rediscovery', { hours: 64, months: 7 }),
    reason('ach_remaining', { remaining: 28, total: 40 }),
    reason('ach_near_complete', { percent: 91.7, remaining: 3 }),
    reason('rare_remaining', { count: 3, threshold: 10 }),
    reason('active_now', { players: 12_345, band: 'high' }),
    reason('friends_all_own', { count: 4 }),
    reason('friends_never_played', { count: 2 }),
    reason('not_rolled_recently', {}),
  ];

  it('render every code (one example each)', () => {
    expect(examples.map(r => r.code).sort()).toEqual([...REASON_CODES].sort());
    expect(examples.map(renderReason)).toEqual([
      'Picked completely at random',
      "You've never launched it",
      "You've only played it for 45 minutes",
      "You haven't played it in 14 months",
      "It's outside your recent rotation",
      "An old favorite: you've put 212 hours into it",
      "You played this for 64 hours but haven't touched it in 7 months",
      '28 of 40 achievements still to unlock',
      "You're already 91% through the achievements in this game (3 to go)",
      '3 locked achievements are held by under 10% of players',
      'Busy right now: 12,345 players online',
      'All 4 players own it',
      '2 players have never played it',
      "QIT hasn't suggested it lately",
    ]);
  });

  it('pluralize and format durations', () => {
    const text = (r: Reason) => renderReason(r);
    expect(text(reason('barely_played', { minutes: 1 }))).toBe("You've only played it for 1 minute");
    expect(text(reason('barely_played', { minutes: 60 }))).toBe("You've only played it for 1 hour");
    expect(text(reason('barely_played', { minutes: 95 }))).toBe("You've only played it for 1 hour 35 minutes");
    expect(text(reason('barely_played', { minutes: 119.6 }))).toBe("You've only played it for 2 hours");
    expect(text(reason('idle', { months: 1 }))).toBe("You haven't played it in 1 month");
    expect(text(reason('idle', { months: 0.4 }))).toBe("You haven't played it in a while");
    expect(text(reason('idle', { months: 36 }))).toBe("You haven't played it in 3 years");
    expect(text(reason('idle', { months: 40 }))).toBe("You haven't played it in over 3 years");
    expect(text(reason('comfort', { hours: 1 }))).toBe("An old favorite: you've put 1 hour into it");
    expect(text(reason('ach_near_complete', { percent: 99.9, remaining: 1 }))).toBe("You're already 99% through the achievements in this game (just 1 to go)");
    expect(text(reason('rare_remaining', { count: 1, threshold: 5 }))).toBe('1 locked achievement is held by under 5% of players');
    expect(text(reason('active_now', { players: 1, band: null }))).toBe('1 player online right now');
    expect(text(reason('active_now', { players: 150, band: 'low' }))).toBe('Quiet right now: 150 players online');
    expect(text(reason('active_now', { players: 900, band: 'mid' }))).toBe('900 players online right now');
    expect(text(reason('friends_all_own', { count: 2 }))).toBe('Both players own it');
    expect(text(reason('friends_all_own', { count: 1 }))).toBe('1 player owns it');
    expect(text(reason('friends_never_played', { count: 1 }))).toBe('1 player has never played it');
  });

  it('order by the mode priority, keep undeclared codes after, and drop repeated codes', () => {
    const ordered = orderReasons([
      reason('friends_all_own', { count: 3 }),
      reason('idle', { months: 20 }),
      reason('never_launched', {}),
      reason('idle', { months: 99 }),
      reason('active_now', { players: 5, band: null }),
    ], ['never_launched', 'idle']);
    expect(ordered).toEqual([
      reason('never_launched', {}),
      reason('idle', { months: 20 }),
      reason('friends_all_own', { count: 3 }),
      reason('active_now', { players: 5, band: null }),
    ]);
  });

  it(`show the top ${CARD_REASON_LIMIT} on a card`, () => {
    expect(renderReasons(examples)).toHaveLength(CARD_REASON_LIMIT);
    expect(renderReasons(examples, 1)).toEqual(['Picked completely at random']);
    expect(renderReasons([])).toEqual([]);
  });

  it('parse stored reasons, stripping unknown params and rejecting malformed ones', () => {
    expect(parseReason({ code: 'idle', params: { months: 4, extra: 'x' } })).toEqual(reason('idle', { months: 4 }));
    expect(parseReason({ code: 'never_launched' })).toEqual(reason('never_launched', {}));
    expect(parseReason({ code: 'active_now', params: { players: 3 } })).toEqual(reason('active_now', { players: 3, band: null }));
    expect(parseReason({ code: 'active_now', params: { players: 3, band: 'low' } })).toEqual(reason('active_now', { players: 3, band: 'low' }));
    for (const bad of [
      null, 'idle', [], { code: 'nope' }, { code: 'toString' }, { code: 'idle' }, { code: 'idle', params: [] },
      { code: 'idle', params: { months: -1 } }, { code: 'idle', params: { months: '4' } },
      { code: 'barely_played', params: { minutes: Number.NaN } },
      { code: 'ach_remaining', params: { remaining: 1.5, total: 4 } },
      { code: 'active_now', params: { players: 3, band: 'extreme' } },
    ]) {
      expect(parseReason(bad)).toBeNull();
    }
    expect(isReasonCode('constructor')).toBe(false);
    for (const r of examples) expect(parseReason(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });
});
