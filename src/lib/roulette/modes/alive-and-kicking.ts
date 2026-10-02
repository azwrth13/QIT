import { isNonGameType } from '../exclusions';
import { reason } from '../reasons';
import { SCOPE_KINDS, type Mode } from '../types';

const aliveAndKicking: Mode = {
  id: 'alive-and-kicking',
  label: 'Alive and Kicking',
  description: 'Multiplayer games with plenty of people playing right now.',
  requires: ['library', 'store', 'live'],
  emits: ['active_now'],
  scopes: [...SCOPE_KINDS],
  stub: false,
  score(candidate, ctx) {
    const { store, live } = candidate.signals;
    if (store?.flags.multiplayer !== true || isNonGameType(store.type)) return { eligible: false, weight: 0, reasons: [] };
    const players = live?.players;
    const known = typeof players === 'number' && Number.isSafeInteger(players) && players >= 0;
    const band = known ? live?.band ?? null : null;
    // Unknown activity is neutral. The absolute floor takes precedence over any supplied band.
    const weight = !known ? 1 : players < ctx.thresholds.activeMinPlayers || band === 'low' ? 1 : band === 'high' ? 4 : band === 'mid' ? 2 : 1;
    return { eligible: true, weight, reasons: known ? [reason('active_now', { players, band })] : [] };
  },
};
export default aliveAndKicking;
