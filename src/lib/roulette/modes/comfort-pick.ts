import { knownPlaytime } from '../../library/backlog';
import { reason } from '../reasons';
import { SCOPE_KINDS, type Mode } from '../types';

const comfortPick: Mode = {
  id: 'comfort-pick',
  label: 'Comfort Pick',
  description: 'Games you have already spent real time in.',
  requires: ['library'],
  emits: ['comfort'],
  scopes: [...SCOPE_KINDS],
  stub: false,
  score(candidate, ctx) {
    const minutes = candidate.signals.library.playtimeForever;
    if (!knownPlaytime(candidate, ctx) || minutes < ctx.thresholds.comfortMinMinutes) return { eligible: false, weight: 0, reasons: [] };
    return {
      eligible: true,
      weight: Math.min(4, Math.sqrt(minutes / Math.max(1, ctx.thresholds.comfortMinMinutes))),
      reasons: [reason('comfort', { hours: minutes / 60 })],
    };
  },
};
export default comfortPick;
