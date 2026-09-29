import type { Filter } from '../types';
import { parseNoParams, storeFlagVerdict, type NoParams } from './params';

// Uses the store's achievements category, which is known for the whole library once metadata is
// cached. Per-user progress (the `achievements` family) is not needed to tell whether a game has any.
const achievements: Filter<NoParams> = {
  id: 'achievements',
  label: 'Has achievements',
  description: 'Games with Steam achievements.',
  requires: ['store'],
  stub: false,
  parse: parseNoParams,
  test: candidate => storeFlagVerdict(candidate, 'achievements'),
};

export default achievements;
