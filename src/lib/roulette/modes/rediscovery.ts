import { idleBeyond } from '../../library/backlog';
import { reason } from '../reasons';
import { SCOPE_KINDS, type Mode } from '../types';

const rediscovery: Mode = {
  id: 'rediscovery',
  label: 'Rediscovery',
  description: 'Games you played a lot but have not touched in a while.',
  requires: ['library'],
  emits: ['rediscovery'],
  scopes: [...SCOPE_KINDS],
  stub: false,
  score(candidate, ctx) {
    const library = candidate.signals.library;
    if (library.playtimeForever < ctx.thresholds.rediscoveryMinMinutes ||
        idleBeyond(candidate, ctx, ctx.thresholds.rediscoveryIdleDays) !== 'match') return { eligible: false, weight: 0, reasons: [] };
    const idleDays = (ctx.now - library.lastPlayedAt!) / 86_400;
    return {
      eligible: true,
      weight: Math.min(4, idleDays / Math.max(1, ctx.thresholds.rediscoveryIdleDays)),
      reasons: [reason('rediscovery', { hours: library.playtimeForever / 60, months: idleDays / 30 })],
    };
  },
};
export default rediscovery;
