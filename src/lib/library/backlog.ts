import { playedWithin } from '../roulette/filters/recency';
import type { Candidate, ScoreContext } from '../roulette/types';

/** Categories may overlap. Unknown playtime and unscanned achievements never match. */
export type BacklogVerdict = 'match' | 'no-match' | 'unknown' | 'unscanned';
export type BacklogContext = Pick<ScoreContext, 'now' | 'thresholds' | 'playtimeHidden'>;
const verdict = (matches: boolean): BacklogVerdict => matches ? 'match' : 'no-match';

export function knownPlaytime(candidate: Candidate, ctx: BacklogContext): boolean {
  const minutes = candidate.signals.library.playtimeForever;
  return !ctx.playtimeHidden && Number.isFinite(minutes) && minutes >= 0;
}

export function neverPlayed(candidate: Candidate, ctx: BacklogContext): BacklogVerdict {
  if (!knownPlaytime(candidate, ctx)) return 'unknown';
  return verdict(candidate.signals.library.playtimeForever <= ctx.thresholds.neverPlayedMinutes);
}

export function barelyPlayed(candidate: Candidate, ctx: BacklogContext): BacklogVerdict {
  if (!knownPlaytime(candidate, ctx)) return 'unknown';
  const minutes = candidate.signals.library.playtimeForever;
  return verdict(minutes > ctx.thresholds.neverPlayedMinutes && minutes < ctx.thresholds.barelyPlayedMinutes);
}

/** Never-launched games have no last session and belong in neverPlayed instead. */
export function notPlayedInLongTime(candidate: Candidate, ctx: BacklogContext): BacklogVerdict {
  return idleBeyond(candidate, ctx, ctx.thresholds.notRecentlyPlayedDays);
}

/** Strictly more than `days`; recent two-week activity overrides an older last-played timestamp. */
export function idleBeyond(candidate: Candidate, ctx: BacklogContext, days: number): BacklogVerdict {
  if (!knownPlaytime(candidate, ctx)) return 'unknown';
  if (neverPlayed(candidate, ctx) === 'match') return 'no-match';
  const library = candidate.signals.library;
  if ((library.playtime2Weeks ?? 0) > 0) return 'no-match';
  if (library.lastPlayedAt === null || library.lastPlayedAt <= 0) return 'unknown';
  const recency = playedWithin(library, days, ctx.now);
  return verdict(recency === 'outside');
}

export function startedButAbandoned(candidate: Candidate, ctx: BacklogContext): BacklogVerdict {
  if (!knownPlaytime(candidate, ctx)) return 'unknown';
  const minutes = candidate.signals.library.playtimeForever;
  if (minutes < ctx.thresholds.abandonedMinMinutes || minutes > ctx.thresholds.abandonedMaxMinutes) return 'no-match';
  // Abandoned includes the exact idle boundary (unlike "not recently played").
  const library = candidate.signals.library;
  if ((library.playtime2Weeks ?? 0) > 0) return 'no-match';
  if (library.lastPlayedAt === null || library.lastPlayedAt <= 0) return 'unknown';
  return verdict(ctx.now - library.lastPlayedAt >= ctx.thresholds.abandonedIdleDays * 86_400);
}

function completion(candidate: Candidate): number | null {
  const achievements = candidate.signals.achievements;
  if (!achievements || !Number.isInteger(achievements.total) || achievements.total <= 0 ||
      !Number.isInteger(achievements.unlocked) || achievements.unlocked < 0 || achievements.unlocked > achievements.total ||
      !Number.isFinite(achievements.percent) || achievements.percent < 0 || achievements.percent > 100) return null;
  return achievements.percent;
}

export function lowCompletion(candidate: Candidate, ctx: BacklogContext): BacklogVerdict {
  const percent = completion(candidate);
  if (percent === null) return 'unscanned';
  return verdict(candidate.signals.achievements!.unlocked < candidate.signals.achievements!.total && percent < ctx.thresholds.finishSomethingPreferPercent);
}

export function highCompletionButUnfinished(candidate: Candidate, ctx: BacklogContext): BacklogVerdict {
  const percent = completion(candidate);
  if (percent === null) return 'unscanned';
  return verdict(percent >= ctx.thresholds.closeToCompletePercent && percent < 100 &&
    candidate.signals.achievements!.unlocked < candidate.signals.achievements!.total);
}

export const BACKLOG_CATEGORIES = {
  'never-played': neverPlayed,
  'barely-played': barelyPlayed,
  'not-played-in-a-long-time': notPlayedInLongTime,
  'started-but-abandoned': startedButAbandoned,
  'low-completion': lowCompletion,
  'high-completion-but-unfinished': highCompletionButUnfinished,
} as const;
export type BacklogCategory = keyof typeof BACKLOG_CATEGORIES;
