import { reason } from '../roulette/reasons';
import type { GroupSignals, Reason } from '../roulette/types';

/** Ownership first, then known never-played count. Text belongs to roulette/renderReason. */
export function groupReasons(group: GroupSignals): Reason[] {
  const reasons: Reason[] = [];
  const members = group.members;
  if (members.length > 0 && members.every(member => member.owns)) {
    reasons.push(reason('friends_all_own', { count: members.length }));
  }
  const count = members.filter(member => member.owns && member.playtimeForever === 0).length;
  if (count > 0) reasons.push(reason('friends_never_played', { count }));
  return reasons;
}
