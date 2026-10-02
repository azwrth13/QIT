import type { Candidate } from '../types';

/** Unknown, malformed, empty and completed summaries cannot offer a hunt. */
export function unfinishedAchievements(candidate: Candidate) {
  const data = candidate.signals.achievements;
  if (!data || !Number.isSafeInteger(data.total) || data.total <= 0 ||
    !Number.isSafeInteger(data.unlocked) || data.unlocked < 0 || data.unlocked >= data.total ||
    !Number.isFinite(data.percent) || data.percent < 0 || data.percent >= 100) return null;
  return { ...data, remaining: data.total - data.unlocked };
}
