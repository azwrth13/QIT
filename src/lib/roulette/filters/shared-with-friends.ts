import { stubFilter } from '../stubs';

export default stubFilter({
  id: 'shared-with-friends',
  label: 'Shared with selected friends',
  description: 'Games the selected friends also own.',
  requires: ['group'],
});
