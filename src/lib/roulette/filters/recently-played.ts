import { stubFilter } from '../stubs';

export default stubFilter({
  id: 'recently-played',
  label: 'Recently played',
  description: 'Games you played recently.',
  requires: ['library'],
});
