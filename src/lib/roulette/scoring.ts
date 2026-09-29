import { orderReasons } from './reasons';
import { weightedSample, type Rng } from './sampler';
import { StubNotImplementedError } from './stubs';
import type { Candidate, Mode, Reason, ScoreContext } from './types';

// The scoring interface: run a mode over a pool, then draw from the eligible games. Pure; the
// spin pipeline builds the pool, applies exclusions and filters, and turns picks into cards.

export interface ScoredCandidate {
  candidate: Candidate;
  /** Finite and above 0; the sampler raises it to `thresholds.samplerGamma`. */
  weight: number;
  /** In the mode's declared priority. */
  reasons: Reason[];
}

export class ModeScopeError extends Error {
  constructor(modeId: string, scopeKind: string) {
    super(`Roulette mode "${modeId}" does not support scope "${scopeKind}"`);
    this.name = 'ModeScopeError';
  }
}

/**
 * Scores every candidate with `mode` and keeps the eligible ones. Ineligible candidates and a
 * weight of 0 drop out; a negative or non-finite weight is a bug in the mode and throws.
 */
export function scoreCandidates(mode: Mode, candidates: readonly Candidate[], ctx: ScoreContext): ScoredCandidate[] {
  if (mode.stub) throw new StubNotImplementedError('mode', mode.id);
  if (!mode.scopes.includes(ctx.scope.kind)) throw new ModeScopeError(mode.id, ctx.scope.kind);
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const score = mode.score(candidate, ctx);
    if (!score.eligible) continue;
    if (!Number.isFinite(score.weight) || score.weight < 0) {
      throw new RangeError(`Roulette mode "${mode.id}" returned weight ${score.weight} for app ${candidate.appid}`);
    }
    if (score.weight === 0) continue;
    scored.push({ candidate, weight: score.weight, reasons: orderReasons(score.reasons, mode.emits) });
  }
  return scored;
}

export interface DrawOptions {
  rng: Rng;
  /** From `ctx.thresholds.samplerGamma`. */
  gamma: number;
  /** How many distinct games to draw, best first; defaults to 1. */
  count?: number;
}

/**
 * Draws distinct games from a scored pool. The pool is put in appid order first, so a seed gives
 * the same pick however the pool was assembled. Duplicate appids throw.
 */
export function drawScored(scored: readonly ScoredCandidate[], options: DrawOptions): ScoredCandidate[] {
  const pool = [...scored].sort((x, y) => x.candidate.appid - y.candidate.appid);
  for (let i = 1; i < pool.length; i++) {
    if (pool[i].candidate.appid === pool[i - 1].candidate.appid) {
      throw new RangeError(`Roulette pool holds app ${pool[i].candidate.appid} twice`);
    }
  }
  return weightedSample(pool.map(entry => ({ item: entry, weight: entry.weight })), options.count ?? 1, options);
}

export interface RollResult {
  picks: ScoredCandidate[];
  /** Candidates the mode found eligible, before the draw. */
  eligible: number;
}

/** Scores the pool with `mode` and draws from it using the context's gamma. */
export function roll(mode: Mode, candidates: readonly Candidate[], ctx: ScoreContext, options: { rng: Rng; count?: number }): RollResult {
  const scored = scoreCandidates(mode, candidates, ctx);
  const picks = drawScored(scored, { rng: options.rng, gamma: ctx.thresholds.samplerGamma, count: options.count });
  return { picks, eligible: scored.length };
}
