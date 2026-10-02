import { isNonGameType } from '../exclusions';
import { reason } from '../reasons';
import type { Mode } from '../types';

const everyoneOwnsIt: Mode = {
  id: 'everyone-owns-it',
  label: 'Everyone Owns It',
  description: 'Only games every selected player owns.',
  requires: ['library', 'group'],
  emits: ['friends_all_own'],
  scopes: ['friends', 'pair', 'lobby'],
  stub: false,
  score(candidate, ctx) {
    const members = candidate.signals.group?.members ?? [];
    const ids = new Set(members.map(member => member.steamId));
    const selected = ctx.scope.kind === 'friends' ? ctx.scope.with : ctx.scope.kind === 'pair' ? [ctx.scope.with] : [];
    if (members.length < 2 || ids.size !== members.length || members.some(member => !member.owns)
      || selected.some(id => !ids.has(id)) || isNonGameType(candidate.signals.store?.type ?? null)) {
      return { eligible: false, weight: 0, reasons: [] };
    }
    return { eligible: true, weight: 1, reasons: [reason('friends_all_own', { count: members.length })] };
  },
};
export default everyoneOwnsIt;
