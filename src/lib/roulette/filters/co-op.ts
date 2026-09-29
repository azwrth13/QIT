import type { Filter } from '../types';
import { parseNoParams, storeFlagVerdict, type NoParams } from './params';

const coOp: Filter<NoParams> = {
  id: 'co-op',
  label: 'Co-op',
  description: 'Games you can play cooperatively.',
  requires: ['store'],
  stub: false,
  parse: parseNoParams,
  test: candidate => storeFlagVerdict(candidate, 'coop'),
};

export default coOp;
