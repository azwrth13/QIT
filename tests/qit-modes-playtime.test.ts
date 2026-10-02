import { describe, expect, it } from 'vitest';
import { BACKLOG_CATEGORIES, barelyPlayed, highCompletionButUnfinished, lowCompletion, neverPlayed, notPlayedInLongTime, startedButAbandoned } from '../src/lib/library/backlog';
import { getMode } from '../src/lib/roulette/modes';
import { renderReasons } from '../src/lib/roulette/reasons';
import { scoreCandidates, drawScored } from '../src/lib/roulette/scoring';
import { THRESHOLDS } from '../src/lib/roulette/thresholds';
import type { Candidate, ModeId, ScoreContext } from '../src/lib/roulette/types';

const DAY = 86_400;
const ctx: ScoreContext = { now: 1_790_000_000, thresholds: THRESHOLDS, scope: { kind: 'library' } };
const modes: ModeId[] = ['dust-collector', 'something-different', 'comfort-pick', 'rediscovery'];
function game(minutes = 0, idleDays: number | null = null, recent: number | null = 0): Candidate {
  return { appid: 620, signals: { library: { name: 'Portal 2', iconHash: null, playtimeForever: minutes, playtime2Weeks: recent, lastPlayedAt: idleDays === null ? null : ctx.now - idleDays * DAY } } };
}
function achievementGame(percent: number, total = 100, unlocked = percent): Candidate {
  const candidate = game();
  candidate.signals.achievements = { percent, total, unlocked, lockedRare: null, lastUnlockAt: null };
  return candidate;
}

describe('backlog category boundaries', () => {
  it('separates never and barely played, with an exclusive upper bound', () => {
    expect(neverPlayed(game(0), ctx)).toBe('match');
    expect(neverPlayed(game(1), ctx)).toBe('no-match');
    expect(barelyPlayed(game(0), ctx)).toBe('no-match');
    expect(barelyPlayed(game(1), ctx)).toBe('match');
    expect(barelyPlayed(game(119), ctx)).toBe('match');
    expect(barelyPlayed(game(120), ctx)).toBe('no-match');
  });
  it('requires more than 90 idle days, excluding unplayed and unknown recency', () => {
    expect(notPlayedInLongTime(game(1, 90), ctx)).toBe('no-match');
    expect(notPlayedInLongTime(game(1, 90 + 1 / DAY), ctx)).toBe('match');
    expect(notPlayedInLongTime(game(0), ctx)).toBe('no-match');
    expect(notPlayedInLongTime(game(1), ctx)).toBe('unknown');
    expect(notPlayedInLongTime(game(1, 400, 1), ctx)).toBe('no-match');
    const zero = game(1); zero.signals.library.lastPlayedAt = 0;
    expect(notPlayedInLongTime(zero, ctx)).toBe('unknown');
  });
  it('includes both abandoned playtime bounds and the exact idle boundary', () => {
    for (const minutes of [30, 600]) expect(startedButAbandoned(game(minutes, 90), ctx)).toBe('match');
    for (const minutes of [29, 601]) expect(startedButAbandoned(game(minutes, 90), ctx)).toBe('no-match');
    expect(startedButAbandoned(game(30, 90 - 1 / DAY), ctx)).toBe('no-match');
    expect(startedButAbandoned(game(30), ctx)).toBe('unknown');
    expect(startedButAbandoned(game(30, 90, 1), ctx)).toBe('no-match');
  });
  it('uses indexed achievement summaries and excludes completed games', () => {
    expect(lowCompletion(achievementGame(0), ctx)).toBe('match');
    expect(lowCompletion(achievementGame(59), ctx)).toBe('match');
    expect(lowCompletion(achievementGame(60), ctx)).toBe('no-match');
    expect(highCompletionButUnfinished(achievementGame(79), ctx)).toBe('no-match');
    expect(highCompletionButUnfinished(achievementGame(80), ctx)).toBe('match');
    expect(highCompletionButUnfinished(achievementGame(99), ctx)).toBe('match');
    expect(highCompletionButUnfinished(achievementGame(100), ctx)).toBe('no-match');
    expect(highCompletionButUnfinished(achievementGame(99, 100, 100), ctx)).toBe('no-match');
    for (const candidate of [game(), achievementGame(0, 0, 0), achievementGame(NaN)]) {
      expect(lowCompletion(candidate, ctx)).toBe('unscanned');
      expect(highCompletionButUnfinished(candidate, ctx)).toBe('unscanned');
    }
    const unavailable = game(); unavailable.signals.achievements = null;
    expect(lowCompletion(unavailable, ctx)).toBe('unscanned');
  });
  it('takes tunable thresholds from the caller', () => {
    const custom = { ...ctx, thresholds: { ...THRESHOLDS, neverPlayedMinutes: 5, barelyPlayedMinutes: 10, notRecentlyPlayedDays: 10, abandonedMinMinutes: 5, abandonedMaxMinutes: 10, abandonedIdleDays: 5, finishSomethingPreferPercent: 20, closeToCompletePercent: 90 } };
    expect(neverPlayed(game(5), custom)).toBe('match');
    expect(barelyPlayed(game(9), custom)).toBe('match');
    expect(barelyPlayed(game(10), custom)).toBe('no-match');
    expect(notPlayedInLongTime(game(6, 11), custom)).toBe('match');
    expect(startedButAbandoned(game(10, 5), custom)).toBe('match');
    expect(lowCompletion(achievementGame(20), custom)).toBe('no-match');
    expect(highCompletionButUnfinished(achievementGame(89), custom)).toBe('no-match');
  });
});

describe('library roulette modes', () => {
  it('weights Dust Collector never, barely and long-idle picks and orders reasons', () => {
    const mode = getMode('dust-collector');
    expect(mode.score(game(), ctx).weight).toBe(4);
    expect(mode.score(game(45), ctx)).toMatchObject({ weight: 3, reasons: [{ code: 'barely_played', params: { minutes: 45 } }] });
    expect(mode.score(game(120, 365), ctx).eligible).toBe(false);
    expect(mode.score(game(120, 366), ctx).weight).toBe(2);
    expect(renderReasons(scoreCandidates(mode, [game(45, 390)], ctx)[0].reasons)).toEqual(["You've only played it for 45 minutes", "You haven't played it in 13 months"]);
  });
  it('skips recent rotation, prefers unplayed games and leaves unknown recency out', () => {
    const mode = getMode('something-different');
    expect(mode.score(game(), ctx).weight).toBe(2);
    expect(mode.score(game(50, 31), ctx).weight).toBe(1);
    for (const candidate of [game(50, 30), game(50, 90, 1), game(50)]) expect(mode.score(candidate, ctx).eligible).toBe(false);
    expect(renderReasons(mode.score(game(), ctx).reasons)).toEqual(["It's outside your recent rotation", "You've never launched it"]);
    expect(renderReasons(mode.score(game(50, 90), ctx).reasons)).toEqual(["It's outside your recent rotation", "You haven't played it in 3 months"]);
  });
  it('weights Comfort Pick by bounded lifetime familiarity without requiring recency', () => {
    const mode = getMode('comfort-pick');
    expect(mode.score(game(1199), ctx).eligible).toBe(false);
    expect(mode.score(game(1200), ctx).weight).toBe(1);
    expect(mode.score(game(4800), ctx).weight).toBe(2);
    expect(mode.score(game(100000), ctx).weight).toBe(4);
    expect(renderReasons(mode.score(game(1200), ctx).reasons)).toEqual(["An old favorite: you've put 20 hours into it"]);
  });
  it('requires meaningful playtime and idle time for Rediscovery', () => {
    const mode = getMode('rediscovery');
    for (const candidate of [game(599, 360), game(600, 180), game(600), game(600, 360, 1)]) expect(mode.score(candidate, ctx).eligible).toBe(false);
    expect(mode.score(game(600, 181), ctx).eligible).toBe(true);
    expect(mode.score(game(600, 360), ctx).weight).toBe(2);
    expect(mode.score(game(600, 1000), ctx).weight).toBe(4);
    expect(renderReasons(mode.score(game(64 * 60, 360), ctx).reasons)).toEqual(["You played this for 64 hours but haven't touched it in 12 months"]);
  });
  it('uses caller thresholds for mode eligibility and weights', () => {
    const custom = { ...ctx, thresholds: { ...THRESHOLDS, barelyPlayedMinutes: 10, longIdleDays: 10, recentRotationDays: 5, comfortMinMinutes: 60, rediscoveryMinMinutes: 60, rediscoveryIdleDays: 10 } };
    expect(getMode('dust-collector').score(game(10, 11), custom).weight).toBe(2);
    expect(getMode('something-different').score(game(10, 6), custom).eligible).toBe(true);
    expect(getMode('something-different').score(game(10, 6, 1), custom).eligible).toBe(false);
    expect(getMode('comfort-pick').score(game(240), custom).weight).toBe(2);
    expect(getMode('rediscovery').score(game(60, 20), custom).weight).toBe(2);
    // A short tuned window cannot turn unknown timestamps into an idle reason.
    expect(getMode('dust-collector').score(game(100), custom).eligible).toBe(false);
    expect(getMode('rediscovery').score(game(100), custom).eligible).toBe(false);
  });
  it.each(modes)('%s uses the registry scoring and weighted draw interface', id => {
    const mode = getMode(id);
    expect(mode).toMatchObject({ stub: false, requires: ['library'] });
    const pool = [game(), game(45, 390), game(4800, 360)].map((g, i) => ({ ...g, appid: i + 1 }));
    const scored = scoreCandidates(mode, pool, ctx);
    expect(scored.length).toBeGreaterThan(0);
    for (const pick of scored) {
      expect(pick.weight).toBeGreaterThan(0);
      expect(pick.reasons.every(r => mode.emits.includes(r.code))).toBe(true);
    }
    expect(drawScored(scored, { rng: () => 0, gamma: THRESHOLDS.samplerGamma })[0]).toEqual(scored[0]);
  });
  it('never matches hidden totals, while achievement categories remain usable', () => {
    const hidden = { ...ctx, playtimeHidden: true };
    for (const id of modes) for (const candidate of [game(), game(4000, 400)]) {
      expect(getMode(id).score(candidate, hidden)).toEqual({ eligible: false, weight: 0, reasons: [] });
    }
    for (const [id, predicate] of Object.entries(BACKLOG_CATEGORIES)) {
      if (!id.includes('completion')) expect(predicate(game(), hidden)).toBe('unknown');
    }
    expect(lowCompletion(achievementGame(10), hidden)).toBe('match');
    expect(highCompletionButUnfinished(achievementGame(90), hidden)).toBe('match');
  });
});
