import { stubFilter } from '../stubs';

export default stubFilter({
  id: 'not-recently-played',
  label: 'Not recently played',
  description: 'Games you have not played for a while.',
  requires: ['library'],
});
