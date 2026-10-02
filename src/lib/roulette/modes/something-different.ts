import { knownPlaytime, neverPlayed } from '../../library/backlog';
import { playedWithin } from '../filters/recency';
import { reason } from '../reasons';
import { SCOPE_KINDS, type Mode } from '../types';

const somethingDifferent: Mode = {
  id: 'something-different',
  label: 'Something Different',
  description: 'Skips your recent rotation in favour of games you have not played lately.',
  requires: ['library'],
  emits: ['outside_rotation', 'never_launched', 'idle'],
  scopes: [...SCOPE_KINDS],
  stub: false,
  score(candidate, ctx) {
    if ((candidate.signals.library.playtime2Weeks ?? 0) > 0 ||
        (candidate.signals.library.lastPlayedAt !== null && candidate.signals.library.lastPlayedAt <= 0 && candidate.signals.library.playtimeForever > 0) ||
        !knownPlaytime(candidate, ctx) || playedWithin(candidate.signals.library, ctx.thresholds.recentRotationDays, ctx.now) !== 'outside') {
      return { eligible: false, weight: 0, reasons: [] };
    }
    const library = candidate.signals.library;
    const reasons = [reason('outside_rotation', {})];
    const never = neverPlayed(candidate, ctx) === 'match';
    if (never) reasons.push(reason('never_launched', {}));
    else if (library.lastPlayedAt !== null && library.lastPlayedAt > 0) {
      reasons.push(reason('idle', { months: (ctx.now - library.lastPlayedAt) / (30 * 86_400) }));
    }
    return { eligible: true, weight: never ? 2 : 1, reasons };
  },
};
export default somethingDifferent;
