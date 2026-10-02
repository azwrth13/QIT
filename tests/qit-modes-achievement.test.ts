import { describe, expect, it } from 'vitest';
import { getMode } from '../src/lib/roulette/modes';
import { renderReasons } from '../src/lib/roulette/reasons';
import { scoreCandidates } from '../src/lib/roulette/scoring';
import { THRESHOLDS } from '../src/lib/roulette/thresholds';
import type { Candidate, ScoreContext } from '../src/lib/roulette/types';

const ctx: ScoreContext = { now: 1_790_000_000, scope: { kind: 'library' }, thresholds: THRESHOLDS };
const day = 86_400;
function game(unlocked = 80, total = 100, minutes = 0, idle: number | null = null): Candidate {
  return { appid: 1, signals: {
    library: { name: 'Game', iconHash: null, playtimeForever: minutes, playtime2Weeks: null,
      lastPlayedAt: idle === null ? null : ctx.now - idle * day },
    achievements: { unlocked, total, percent: unlocked / total * 100, lockedRare: null, lastUnlockAt: null },
  } };
}
const hunter = getMode('achievement-hunter');
const finish = getMode('finish-something');

describe('achievement modes', () => {
  it.each([hunter, finish])('$id excludes unknown, empty, completed and malformed summaries', mode => {
    const unknown = game(); delete unknown.signals.achievements;
    const noStats = game(); noStats.signals.achievements = null;
    for (const candidate of [unknown, noStats, game(0, 0), game(100), game(101), game(-1), game(1.5), game(80, Number.NaN)]) {
      expect(mode.score(candidate, ctx)).toEqual({ eligible: false, weight: 0, reasons: [] });
    }
    const roundedComplete = game(99); roundedComplete.signals.achievements!.percent = 100;
    expect(mode.score(roundedComplete, ctx).eligible).toBe(false);
  });

  it('hunter weights many remaining and near completion at inclusive edges', () => {
    expect(hunter.score(game(76), ctx).weight).toBe(1); // 24 remaining
    expect(hunter.score(game(75), ctx).weight).toBe(3); // 25 remaining
    expect(hunter.score(game(79), ctx).reasons.map(r => r.code)).toEqual(['ach_remaining']);
    expect(hunter.score(game(80), ctx)).toMatchObject({ weight: 3, reasons: [
      { code: 'ach_remaining', params: { remaining: 20, total: 100 } },
      { code: 'ach_near_complete', params: { percent: 80, remaining: 20 } },
    ] });
    expect(hunter.score(game(0), ctx).eligible).toBe(true);
  });

  it('hunter gives abandoned games a bonus only within playtime and idle edges', () => {
    for (const [minutes, idle, expected] of [[29, 90, 3], [30, 89, 3], [30, 90, 4], [600, 90, 4], [601, 90, 3]]) {
      const score = hunter.score(game(80, 100, minutes, idle), ctx);
      expect(score.weight).toBe(expected);
      expect(score.reasons.some(r => r.code === 'idle')).toBe(expected === 4);
    }
    expect(hunter.score(game(80, 100, 30), ctx).weight).toBe(3);
    expect(hunter.score(game(80, 100, 30, -1), ctx).weight).toBe(3);
    const recent = game(80, 100, 30, 90); recent.signals.library.playtime2Weeks = 1;
    expect(hunter.score(recent, ctx).weight).toBe(3);
  });

  it('finish eligibility and near-completion reasons change at configured edges', () => {
    expect(finish.score(game(59), ctx).eligible).toBe(false);
    expect(finish.score(game(60), ctx)).toEqual({ eligible: true, weight: 1.6,
      reasons: [{ code: 'ach_remaining', params: { remaining: 40, total: 100 } }] });
    expect(finish.score(game(79), ctx).weight).toBeCloseTo(1.79);
    expect(finish.score(game(80), ctx).weight).toBeCloseTo(3.8);
    expect(finish.score(game(80), ctx).reasons).toEqual([{ code: 'ach_near_complete', params: { percent: 80, remaining: 20 } }]);
    expect(finish.score(game(94), ctx).weight).toBeCloseTo(3.94);
    expect(finish.score(game(95), ctx).weight).toBeCloseTo(5.95);
    expect(finish.score(game(99), ctx).eligible).toBe(true);
  });

  it('finish prefers existing investment and recent previous activity with bounded bonuses', () => {
    expect(finish.score(game(91, 100, 300), ctx).weight).toBeCloseTo(4.41);
    expect(finish.score(game(91, 100, 600), ctx).weight).toBeCloseTo(4.91);
    expect(finish.score(game(91, 100, 60_000), ctx).weight).toBeCloseTo(4.91);
    expect(finish.score(game(91, 100, 0, 30), ctx).weight).toBeCloseTo(4.91);
    expect(finish.score(game(91, 100, 0, 30 + 1 / day), ctx).weight).toBeCloseTo(3.91);
    expect(finish.score(game(91, 100, 0, -1), ctx).weight).toBeCloseTo(4.91);
    const recent = game(91); recent.signals.library.playtime2Weeks = 1;
    expect(finish.score(recent, ctx).weight).toBeCloseTo(4.91);
    const unknownSession = game(91, 100, 300); unknownSession.signals.library.playtime2Weeks = 0;
    expect(finish.score(unknownSession, ctx).weight).toBeCloseTo(4.41);
  });

  it('finish and something different agree on recent rotation', () => {
    const different = getMode('something-different');
    const cases = [game(91, 100, 0, 30), game(91, 100, 300, 31), game(91, 100, 300, -1), game(91, 100, 0)];
    const twoWeeks = game(91, 100, 300); twoWeeks.signals.library.playtime2Weeks = 1;
    for (const candidate of [...cases, twoWeeks]) {
      const recent = finish.score(candidate, ctx).weight - finish.score(game(91, 100, candidate.signals.library.playtimeForever), ctx).weight > 0.5;
      expect(recent).toBe(!different.score(candidate, ctx).eligible);
    }
  });

  it.each([hunter, finish])('$id keeps achievement eligibility while suppressing hidden-playtime bonuses', mode => {
    const invested = game(91, 100, 300, 90);
    if (mode === finish) invested.signals.library.playtime2Weeks = 5;
    expect(mode.score(invested, { ...ctx, playtimeHidden: true })).toEqual(mode.score(game(91), ctx));
    expect(mode.score(invested, ctx).weight).toBeGreaterThan(mode.score(game(91), ctx).weight);
  });

  it('uses supplied thresholds rather than hardcoded eligibility and bonus edges', () => {
    const tuned = { ...ctx, thresholds: { ...THRESHOLDS, finishSomethingPreferPercent: 50,
      closeToCompletePercent: 70, manyRemainingLocked: 30, finishSomethingFewRemaining: 10 } };
    expect(finish.score(game(50), tuned).eligible).toBe(true);
    expect(finish.score(game(70), tuned).reasons[0].code).toBe('ach_near_complete');
    expect(finish.score(game(90), tuned).weight).toBeCloseTo(5.9);
    expect(hunter.score(game(75), tuned).weight).toBe(3); // close only, fewer than 30 remaining
    expect(hunter.score(game(70), tuned).weight).toBe(5); // both bonuses
  });

  it('declares reason priority and uses the existing renderer', () => {
    const score = scoreCandidates(hunter, [game(160, 200, 30, 90)], ctx)[0];
    expect(score.reasons.map(r => r.code)).toEqual(['ach_remaining', 'ach_near_complete', 'idle']);
    expect(hunter.emits).toEqual(['ach_remaining', 'ach_near_complete', 'idle']);
    expect(finish.emits).toEqual(['ach_near_complete', 'ach_remaining']);
    const near = scoreCandidates(finish, [game(91)], ctx)[0];
    expect(renderReasons(near.reasons)).toEqual(["You're already 91% through the achievements in this game (9 to go)"]);
  });
});
