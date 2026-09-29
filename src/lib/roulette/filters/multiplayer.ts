import type { Filter } from '../types';
import { parseNoParams, storeFlagVerdict, type NoParams } from './params';

// Any category that means playing with other people: co-op, PvP and MMO games count as multiplayer
// even when the store does not also tag them "Multi-player".
const multiplayer: Filter<NoParams> = {
  id: 'multiplayer',
  label: 'Multiplayer',
  description: 'Games with multiplayer support.',
  requires: ['store'],
  stub: false,
  parse: parseNoParams,
  test: candidate => storeFlagVerdict(candidate, 'multiplayer', 'coop', 'pvp', 'mmo'),
};

export default multiplayer;
