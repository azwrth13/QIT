import type { GroupSignals } from '../roulette/types';

/** D5 default, in hours. Callers can supply another experienced-player threshold. */
export const EXPERIENCED_HOURS = 10;

const shared = (group: GroupSignals): boolean => group.members.length > 0 && group.members.every(member => member.owns);
const known = (minutes: number | null): minutes is number => minutes !== null && Number.isFinite(minutes) && minutes >= 0;
function threshold(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(hours * 60)) throw new RangeError('Hours must be finite and positive');
  return hours * 60;
}

/** Feature 15 predicates operate on shared games; empty groups never match. */
export function nobodyPlayed(group: GroupSignals): boolean {
  return shared(group) && group.members.every(member => member.playtimeForever === 0);
}

export function atLeastOneNeverPlayed(group: GroupSignals): boolean {
  return shared(group) && group.members.some(member => member.playtimeForever === 0);
}

/** Strictly less than the given number of hours; hidden or missing playtime cannot match. */
export function everyoneUnderHours(group: GroupSignals, hours: number): boolean {
  const limit = threshold(hours);
  return shared(group) && group.members.every(member => known(member.playtimeForever) && member.playtimeForever < limit);
}

/** Exactly one veteran and at least one newcomer, with every newcomer known to have zero playtime. */
export function veteranWithNewcomers(group: GroupSignals, experiencedHours = EXPERIENCED_HOURS): boolean {
  const limit = threshold(experiencedHours);
  return shared(group) && group.members.length >= 2 && group.members.some(veteran =>
    known(veteran.playtimeForever) && veteran.playtimeForever >= limit &&
    group.members.every(member => member === veteran || member.playtimeForever === 0));
}
