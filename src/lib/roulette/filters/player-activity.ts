import type { Filter } from '../types';
import { paramObject } from './params';

// The three modes of feature 9. `active` is the absolute floor; `high` and `low` are the pool-relative
// bands (D15: P75 and P25) that the pipeline attaches to each candidate's live signals.
export const ACTIVITY_MODES = ['active', 'high', 'low'] as const;
export type ActivityMode = typeof ACTIVITY_MODES[number];

export interface PlayerActivityParams {
  mode: ActivityMode;
}

const playerActivity: Filter<PlayerActivityParams> = {
  id: 'player-activity',
  label: 'Player activity',
  description: 'Games by how many people are playing right now.',
  requires: ['live'],
  stub: false,
  parse(raw) {
    const object = paramObject(raw, ['mode']);
    const mode = object?.mode;
    return typeof mode === 'string' && (ACTIVITY_MODES as readonly string[]).includes(mode)
      ? { mode: mode as ActivityMode }
      : null;
  },
  test(candidate, params, ctx) {
    // An app with no player counter (players null) has an unknown, not a zero, activity.
    const live = candidate.signals.live;
    if (!live || live.players === null) return 'unknown';
    const aboveFloor = live.players >= ctx.thresholds.activeMinPlayers;
    if (params.mode === 'active') return aboveFloor ? 'pass' : 'fail';
    if (live.band === null) return 'unknown';
    // A high band never applies below the absolute floor, however quiet the rest of the pool is.
    if (params.mode === 'high') return live.band === 'high' && aboveFloor ? 'pass' : 'fail';
    return live.band === 'low' ? 'pass' : 'fail';
  },
};

export default playerActivity;
