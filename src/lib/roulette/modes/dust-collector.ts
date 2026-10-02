import { barelyPlayed, idleBeyond, neverPlayed } from '../../library/backlog';
import { reason } from '../reasons';
import { SCOPE_KINDS, type Mode, type Reason } from '../types';

const dustCollector: Mode = {
  id: 'dust-collector',
  label: 'Dust Collector',
  description: 'Games you own but have barely played or not played in a long time.',
  requires: ['library'],
  emits: ['never_launched', 'barely_played', 'idle'],
  scopes: [...SCOPE_KINDS],
  stub: false,
  score(candidate, ctx) {
    const reasons: Reason[] = [];
    let weight = 0;
    if (neverPlayed(candidate, ctx) === 'match') {
      weight = 4;
      reasons.push(reason('never_launched', {}));
    } else if (barelyPlayed(candidate, ctx) === 'match') {
      weight = 3;
      reasons.push(reason('barely_played', { minutes: candidate.signals.library.playtimeForever }));
    }
    if (idleBeyond(candidate, ctx, ctx.thresholds.longIdleDays) === 'match') {
      weight = Math.max(weight, 2);
      reasons.push(reason('idle', { months: (ctx.now - candidate.signals.library.lastPlayedAt!) / (30 * 86_400) }));
    }
    return { eligible: weight > 0, weight, reasons };
  },
};
export default dustCollector;
