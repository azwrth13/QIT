import { reason } from '../reasons';
import type { Mode } from '../types';
import { recentActivity, unfinishedAchievements } from './achievement-signals';

const finishSomething: Mode = {
  id: 'finish-something',
  label: 'Finish Something',
  description: 'Games you are already close to completing.',
  requires: ['library', 'achievements'],
  emits: ['ach_near_complete', 'ach_remaining'],
  scopes: ['library', 'appids'],
  stub: false,
  score(candidate, ctx) {
    const data = unfinishedAchievements(candidate);
    const t = ctx.thresholds;
    if (!data || data.percent < t.finishSomethingPreferPercent) return { eligible: false, weight: 0, reasons: [] };
    const { percent, remaining, total } = data;
    let weight = 1 + percent / 100;
    if (percent >= t.closeToCompletePercent) weight += 2;
    if (remaining <= t.finishSomethingFewRemaining) weight += 2;
    const minutes = candidate.signals.library.playtimeForever;
    if (!ctx.playtimeHidden && Number.isFinite(minutes) && minutes > 0) {
      // Cap investment so a long game cannot dominate closeness to completion.
      weight += Math.min(minutes / Math.max(1, t.abandonedMaxMinutes), 1);
    }
    if (recentActivity(candidate, ctx)) weight += 1;
    return {
      eligible: true, weight,
      reasons: [percent >= t.closeToCompletePercent
        ? reason('ach_near_complete', { percent, remaining })
        : reason('ach_remaining', { remaining, total })],
    };
  },
};

export default finishSomething;
