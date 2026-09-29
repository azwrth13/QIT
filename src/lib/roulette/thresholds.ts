import type { Thresholds } from './types';

// Tunable defaults (plan section 2.4, captain decisions D4, D5, D6 and D15). Engines take a
// `Thresholds` through their context rather than importing this directly, so tests can vary them.
export const THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  neverPlayedMinutes: 0,
  // Steam's refund window.
  barelyPlayedMinutes: 120,
  notRecentlyPlayedDays: 90,
  // Also counts as recent rotation: any playtime in the last two weeks.
  recentRotationDays: 30,
  longIdleDays: 365,
  rediscoveryMinMinutes: 10 * 60,
  rediscoveryIdleDays: 180,
  comfortMinMinutes: 20 * 60,
  abandonedMinMinutes: 30,
  abandonedMaxMinutes: 10 * 60,
  abandonedIdleDays: 90,
  closeToCompletePercent: 80,
  // Finish Something weights games from this completion upward.
  finishSomethingPreferPercent: 60,
  manyRemainingLocked: 25,
  rareTiersPercent: Object.freeze([25, 10, 5]),
  // Absolute floor for "active"; bands are relative to the pool (high >= P75, low <= P25).
  activeMinPlayers: 100,
  activityHighPercentile: 75,
  activityLowPercentile: 25,
  antiRepeatDays: 30,
  // User-selectable anti-repeat windows; 0 means off.
  antiRepeatDayOptions: Object.freeze([0, 7, 30, 90]),
  // A roll counts as played once playtime rose this much since the roll.
  playedDeltaMinutes: 10,
  // The sampler draws with probability proportional to weight ^ gamma.
  samplerGamma: 1.5,
});

export const DAY_SECONDS = 24 * 60 * 60;
