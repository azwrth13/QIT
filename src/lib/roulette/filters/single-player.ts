import type { Filter } from '../types';
import { parseNoParams, storeFlagVerdict, type NoParams } from './params';

const singlePlayer: Filter<NoParams> = {
  id: 'single-player',
  label: 'Single-player',
  description: 'Games you can play on your own.',
  requires: ['store'],
  stub: false,
  parse: parseNoParams,
  test: candidate => storeFlagVerdict(candidate, 'singlePlayer'),
};

export default singlePlayer;
