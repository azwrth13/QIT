import { stubFilter } from '../stubs';

export default stubFilter({
  id: 'exclude-rolled',
  label: 'Exclude previously rolled',
  description: 'Leaves out games QIT picked for you recently.',
  requires: ['history'],
});
