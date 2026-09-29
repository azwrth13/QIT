import { stubMode } from '../stubs';

export default stubMode({
  id: 'something-different',
  label: 'Something Different',
  description: 'Skips your recent rotation in favour of games you have not played lately.',
  requires: ['library'],
});
