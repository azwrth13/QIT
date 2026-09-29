import type { Filter } from '../types';
import { paramObject, isIntInRange, MAX_DAYS } from './params';

const DAY_SECONDS = 24 * 60 * 60;

export interface ExcludeRolledParams {
  /** Anti-repeat window in days; 0 turns the filter off. Defaults to `thresholds.antiRepeatDays` (D6). */
  days?: number;
}

const excludeRolled: Filter<ExcludeRolledParams> = {
  id: 'exclude-rolled',
  label: 'Exclude previously rolled',
  description: 'Leaves out games QIT picked for you recently.',
  requires: ['history'],
  stub: false,
  parse(raw) {
    const object = paramObject(raw, ['days']);
    if (!object) return null;
    if (object.days === undefined) return {};
    return isIntInRange(object.days, 0, MAX_DAYS) ? { days: object.days } : null;
  },
  test(candidate, params, ctx) {
    const days = params.days ?? ctx.thresholds.antiRepeatDays;
    if (days === 0) return 'pass';
    const history = candidate.signals.history;
    if (!history) return 'unknown';
    if (history.lastRolledAt === null) return history.timesRolled > 0 ? 'unknown' : 'pass';
    return ctx.now - history.lastRolledAt < days * DAY_SECONDS ? 'fail' : 'pass';
  },
};

export default excludeRolled;
