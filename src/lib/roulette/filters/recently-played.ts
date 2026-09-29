import type { Filter } from '../types';
import { parseDaysParams, type DaysParams } from './params';
import { playedWithin } from './recency';

const recentlyPlayed: Filter<DaysParams> = {
  id: 'recently-played',
  label: 'Recently played',
  description: 'Games you played recently.',
  requires: ['library'],
  stub: false,
  parse: parseDaysParams,
  test(candidate, params, ctx) {
    // The window defaults to `thresholds.recentRotationDays`.
    const days = params.days ?? ctx.thresholds.recentRotationDays;
    const recency = playedWithin(candidate.signals.library, days, ctx.now);
    return recency === 'within' ? 'pass' : recency === 'outside' ? 'fail' : 'unknown';
  },
};

export default recentlyPlayed;
