import { stubFilter } from '../stubs';

export default stubFilter({
  id: 'playtime',
  label: 'Playtime',
  description: 'Games within a minimum and maximum playtime.',
  requires: ['library'],
});
