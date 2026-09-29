import type { Filter } from '../types';
import { parseNoParams, type NoParams } from './params';

// Playtime is always in the library index, so this never returns unknown. When a user hides their
// total playtime every game reads as zero; the pipeline must disable playtime filters in that case.
const neverPlayed: Filter<NoParams> = {
  id: 'never-played',
  label: 'Never played',
  description: 'Games you have never launched.',
  requires: ['library'],
  stub: false,
  parse: parseNoParams,
  test: (candidate, _params, ctx) =>
    candidate.signals.library.playtimeForever <= ctx.thresholds.neverPlayedMinutes ? 'pass' : 'fail',
};

export default neverPlayed;
