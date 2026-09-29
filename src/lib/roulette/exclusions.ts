import type { Candidate, SignalFamily } from './types';

// The exclusion stage (features 14 and D17). It runs before the session filters and drops games the
// user has ruled out, so they are never scored or drawn. Pure: history and store data arrive on the
// candidates' signals.

/** Why a game left the pool. */
export type ExclusionCause = 'request' | 'vetoed' | 'non_game';
export const EXCLUSION_CAUSES: readonly ExclusionCause[] = ['request', 'vetoed', 'non_game'];

export interface ExclusionOptions {
  /** Appids to leave out of this spin only, for example earlier results of the same session. */
  exclude?: readonly number[];
  /** Keep non-game apps (software, DLC, tools and so on) in the pool. They are hidden by default (D17). */
  showNonGames?: boolean;
}

/**
 * Store item types that are not games. A denylist, so a type this list does not know (a demo, a beta)
 * stays in the pool: unknown is never a reason to exclude.
 */
export const NON_GAME_TYPES: ReadonlySet<string> = new Set([
  'application', 'software', 'tool', 'dlc', 'music', 'video', 'hardware', 'series', 'advertising',
]);

export function isNonGameType(type: string | null): boolean {
  return type !== null && NON_GAME_TYPES.has(type.toLowerCase());
}

/**
 * Signal families the stage reads. Vetoes always come from `history`; the store type is needed only
 * while non-games are being hidden.
 */
export function exclusionRequires(options: ExclusionOptions = {}): SignalFamily[] {
  return options.showNonGames ? ['history'] : ['history', 'store'];
}

/** The first reason that removes the candidate, or null to keep it. Vetoes win over the rest. */
export function exclusionCause(candidate: Candidate, options: ExclusionOptions, excluded: ReadonlySet<number>): ExclusionCause | null {
  // The history loader sets `excluded` only for exclusions still active (session, day, 7d, forever).
  if (candidate.signals.history?.excluded) return 'vetoed';
  if (excluded.has(candidate.appid)) return 'request';
  if (!options.showNonGames && isNonGameType(candidate.signals.store?.type ?? null)) return 'non_game';
  return null;
}

export interface ExclusionResult {
  kept: Candidate[];
  removed: Record<ExclusionCause, number>;
}

export function applyExclusions(candidates: readonly Candidate[], options: ExclusionOptions = {}): ExclusionResult {
  const excluded = new Set(options.exclude);
  const removed: Record<ExclusionCause, number> = { request: 0, vetoed: 0, non_game: 0 };
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    const cause = exclusionCause(candidate, options, excluded);
    if (cause) removed[cause]++;
    else kept.push(candidate);
  }
  return { kept, removed };
}
