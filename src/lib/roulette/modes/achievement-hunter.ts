import { stubMode } from '../stubs';

export default stubMode({
  id: 'achievement-hunter',
  label: 'Achievement Hunter',
  description: 'Games with achievements still left to unlock.',
  requires: ['library', 'achievements'],
});
