import { stubFilter } from '../stubs';

export default stubFilter({
  id: 'player-activity',
  label: 'Player activity',
  description: 'Games by how many people are playing right now.',
  requires: ['live'],
});
