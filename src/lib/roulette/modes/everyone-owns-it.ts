import { stubMode } from '../stubs';

export default stubMode({
  id: 'everyone-owns-it',
  label: 'Everyone Owns It',
  description: 'Only games every selected player owns.',
  requires: ['library', 'group'],
  scopes: ['friends', 'pair', 'lobby'],
});
