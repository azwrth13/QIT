import { stubMode } from '../stubs';

export default stubMode({
  id: 'finish-something',
  label: 'Finish Something',
  description: 'Games you are already close to completing.',
  requires: ['library', 'achievements'],
});
