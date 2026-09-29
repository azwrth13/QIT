import { SCOPE_KINDS, type Mode } from '../types';

// Every eligible game gets the same weight, so gamma has no effect and each is equally likely.
const pureRandom: Mode = {
  id: 'pure-random',
  label: 'Pure Random',
  description: 'Any eligible game, each equally likely.',
  requires: ['library'],
  emits: ['random_pick'],
  scopes: [...SCOPE_KINDS],
  stub: false,
  score: () => ({ eligible: true, weight: 1, reasons: [{ code: 'random_pick', params: {} }] }),
};

export default pureRandom;
