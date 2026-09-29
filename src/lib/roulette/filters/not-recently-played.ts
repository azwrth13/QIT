import type { Filter } from '../types';
import { parseDaysParams, type DaysParams } from './params';
import { playedWithin } from './recency';

// A game with no playtime counts as not played recently, so this includes never-played games.
const notRecentlyPlayed: Filter<DaysParams> = {
  id: 'not-recently-played',
  label: 'Not played recently',
  description: 'Games you have not played for a while.',
  requires: ['library'],
  stub: false,
  parse: parseDaysParams,
  test(candidate, params, ctx) {
    // The window defaults to `thresholds.notRecentlyPlayedDays`.
    const days = params.days ?? ctx.thresholds.notRecentlyPlayedDays;
    const recency = playedWithin(candidate.signals.library, days, ctx.now);
    return recency === 'outside' ? 'pass' : recency === 'within' ? 'fail' : 'unknown';
  },
};

export default notRecentlyPlayed;
