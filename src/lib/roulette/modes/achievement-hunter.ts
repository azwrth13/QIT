import { startedButAbandoned } from '../../library/backlog';
import { reason } from '../reasons';
import type { Mode, Reason } from '../types';
import { unfinishedAchievements } from './achievement-signals';

const achievementHunter: Mode = {
  id: 'achievement-hunter',
  label: 'Achievement Hunter',
  description: 'Games with achievements still left to unlock.',
  requires: ['library', 'achievements'],
  emits: ['ach_remaining', 'ach_near_complete', 'idle'],
  scopes: ['library', 'appids'],
  stub: false,
  score(candidate, ctx) {
    const data = unfinishedAchievements(candidate);
    if (!data) return { eligible: false, weight: 0, reasons: [] };
    const { percent, remaining, total } = data;
    const t = ctx.thresholds;
    let weight = 1;
    const reasons: Reason[] = [reason('ach_remaining', { remaining, total })];
    if (remaining >= t.manyRemainingLocked) weight += 2;
    if (percent >= t.closeToCompletePercent) {
      weight += 2;
      reasons.push(reason('ach_near_complete', { percent, remaining }));
    }
    if (startedButAbandoned(candidate, ctx) === 'match') {
      weight += 1;
      reasons.push(reason('idle', { months: (ctx.now - candidate.signals.library.lastPlayedAt!) / (30 * 86_400) }));
    }
    return { eligible: true, weight, reasons };
  },
};

export default achievementHunter;
