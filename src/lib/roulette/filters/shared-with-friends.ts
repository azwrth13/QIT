import { isSteamId } from '../../steam';
import type { Filter, Scope } from '../types';
import { paramObject } from './params';

/** Friends a filter can name; matches the `?with=` cap in `links/with-param.ts`. */
const MAX_FRIENDS = 16;

export interface SharedWithFriendsParams {
  /**
   * Friends that must own the game. Omitted means the friends the scope names (`friends` and `pair`
   * scopes), or every scope player (`FilterContext.members`, else the group signals) when it names none.
   */
  with?: string[];
  /** `all` (the default) needs every selected friend to own it; `any` needs at least one. */
  match?: 'all' | 'any';
}

function friendsOf(params: SharedWithFriendsParams, scope: Scope): string[] | null {
  if (params.with) return params.with;
  if (scope.kind === 'friends') return scope.with;
  if (scope.kind === 'pair') return [scope.with];
  return null;
}

const sharedWithFriends: Filter<SharedWithFriendsParams> = {
  id: 'shared-with-friends',
  label: 'Shared with selected friends',
  description: 'Games the selected friends also own.',
  requires: ['group'],
  stub: false,
  parse(raw) {
    const object = paramObject(raw, ['with', 'match']);
    if (!object) return null;
    const { match } = object;
    if (match !== undefined && match !== 'all' && match !== 'any') return null;
    const parsed: SharedWithFriendsParams = match ? { match } : {};
    if (object.with !== undefined) {
      const ids = object.with;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_FRIENDS) return null;
      if (!ids.every(isSteamId) || new Set(ids).size !== ids.length) return null;
      parsed.with = ids;
    }
    return parsed;
  },
  test(candidate, params, ctx) {
    const group = candidate.signals.group;
    if (!group) return 'unknown';
    const members = new Map(group.members.map(member => [member.steamId, member]));
    const selected = friendsOf(params, ctx.scope) ?? ctx.members ?? [...members.keys()];
    if (selected.length === 0) return 'unknown';
    // A friend missing from the group had no readable library (private, not found or errored).
    const owns = selected.map(id => members.get(id)?.owns);
    if ((params.match ?? 'all') === 'any') {
      if (owns.includes(true)) return 'pass';
      return owns.includes(undefined) ? 'unknown' : 'fail';
    }
    if (owns.includes(false)) return 'fail';
    return owns.includes(undefined) ? 'unknown' : 'pass';
  },
};

export default sharedWithFriends;
