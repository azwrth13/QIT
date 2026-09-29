import { stubFilter } from '../stubs';

export default stubFilter({
  id: 'never-played',
  label: 'Never played',
  description: 'Games you have never launched.',
  requires: ['library'],
});
