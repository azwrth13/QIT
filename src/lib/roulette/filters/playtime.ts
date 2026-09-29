import type { Filter } from '../types';
import { isIntInRange, paramObject } from './params';

export interface PlaytimeParams {
  /** Minutes, inclusive. */
  minMinutes?: number;
  /** Minutes, inclusive. */
  maxMinutes?: number;
}

/** Ten million minutes is about 19 years, past anything a Steam account holds. */
const MAX_MINUTES = 10_000_000;

const playtime: Filter<PlaytimeParams> = {
  id: 'playtime',
  label: 'Playtime',
  description: 'Games within a minimum and maximum playtime.',
  requires: ['library'],
  stub: false,
  parse(raw) {
    const object = paramObject(raw, ['minMinutes', 'maxMinutes']);
    if (!object) return null;
    const { minMinutes, maxMinutes } = object;
    if (minMinutes === undefined && maxMinutes === undefined) return null;
    if (minMinutes !== undefined && !isIntInRange(minMinutes, 0, MAX_MINUTES)) return null;
    if (maxMinutes !== undefined && !isIntInRange(maxMinutes, 0, MAX_MINUTES)) return null;
    if (minMinutes !== undefined && maxMinutes !== undefined && minMinutes > maxMinutes) return null;
    return {
      ...(minMinutes !== undefined && { minMinutes }),
      ...(maxMinutes !== undefined && { maxMinutes }),
    };
  },
  test(candidate, params) {
    const minutes = candidate.signals.library.playtimeForever;
    if (params.minMinutes !== undefined && minutes < params.minMinutes) return 'fail';
    if (params.maxMinutes !== undefined && minutes > params.maxMinutes) return 'fail';
    return 'pass';
  },
};

export default playtime;
