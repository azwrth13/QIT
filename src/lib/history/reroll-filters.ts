import type { FilterSelection } from '../roulette/types';

export function buildRerollFilters(stored: FilterSelection[] | undefined, antiRepeatDays: number): FilterSelection[] {
  const base = stored ?? [];
  if (antiRepeatDays <= 0 || base.some(f => f.id === 'exclude-rolled')) return base;
  return [...base, { id: 'exclude-rolled', params: { days: antiRepeatDays } }];
}
