import { intersect, type GroupLibrary } from '../../group/libraries';
import { decodeGames, getLibraryFor, QIT_INDEX_MAX_AGE_MS, type FriendLibrary } from '../../social/libraries';
import { firestoreSocialStore } from '../../social/store';
import { logServerError } from '../../steam';
import { SpinInputError, type SpinScopeResolver, type SpinScopeResult } from '../pipeline';
import type { LibIndexEntry } from '../../store/types';
import { libraryScope } from './library';

/** Pool previews never refresh Steam libraries or write caches. A cache miss is unavailable. */
async function cachedLibraries(ids: string[], now: number): Promise<FriendLibrary[]> {
  try {
    const [qit, cached] = await Promise.all([
      firestoreSocialStore.readQitLibraries(ids), firestoreSocialStore.readPublicLibraries(ids),
    ]);
    return ids.map(steamId => {
      const library = qit.get(steamId);
      const age = library?.syncedAt === null || library?.syncedAt === undefined ? Infinity : now - library.syncedAt;
      if (library && age >= 0 && age <= QIT_INDEX_MAX_AGE_MS) {
        return { steamId, state: 'ok', games: library.games, source: 'qit', fetchedAt: library.syncedAt };
      }
      const record = cached.get(steamId);
      if (record && record.expiresAt.toMillis() > now) {
        const games = record.state === 'ok' ? decodeGames(record.games) : new Map<number, LibIndexEntry>();
        if (games) return { steamId, state: record.state, games, source: 'steam', fetchedAt: record.fetchedAt.toMillis() };
      }
      return { steamId, state: 'error', games: new Map(), source: 'steam', fetchedAt: null };
    });
  } catch (error) {
    logServerError('Group preview cache read failed', error);
    return ids.map(steamId => ({ steamId, state: 'error', games: new Map(), source: 'steam', fetchedAt: null }));
  }
}

/** Strict ownership intersection: an unreadable selected player never silently leaves the group. */
async function resolveGroup(selected: string[], ctx: { steamId: string; now: number; fetch?: boolean }): Promise<SpinScopeResult> {
  const others = [...new Set(selected)].filter(id => id !== ctx.steamId);
  if (!others.length) throw new SpinInputError('group scope needs another player');
  const [own, friends] = await Promise.all([
    libraryScope.resolve({ kind: 'library' }, ctx),
    ctx.fetch === false ? cachedLibraries(others, ctx.now) : getLibraryFor(others),
  ]);
  const unavailable = friends.filter(friend => friend.state !== 'ok').map(friend => ({
    steamId: friend.steamId, state: friend.state as 'private' | 'not_found' | 'error',
  }));
  const members = [ctx.steamId, ...friends.filter(friend => friend.state === 'ok').map(friend => friend.steamId)];
  if (unavailable.length) return { candidates: [], members, unavailable, playtimeHidden: own.playtimeHidden };
  const games = new Map<number, LibIndexEntry>(own.candidates.map(({ appid, signals: { library } }) => [appid, {
    n: library.name, i: library.iconHash ?? '', p: library.playtimeForever,
    ...(library.playtime2Weeks !== null ? { w: library.playtime2Weeks } : {}),
    ...(library.lastPlayedAt !== null ? { r: library.lastPlayedAt } : {}),
  }]));
  const libraries: GroupLibrary[] = [{ steamId: ctx.steamId, games, playtimeHidden: own.playtimeHidden }, ...friends];
  const shared = new Map(intersect(libraries).map(game => [game.appid, game.group]));
  const candidates = own.candidates.filter(candidate => shared.has(candidate.appid)).map(candidate => ({
    ...candidate, signals: { ...candidate.signals, group: shared.get(candidate.appid)! },
  }));
  return { candidates, members, unavailable: [], playtimeHidden: own.playtimeHidden };
}

export const friendsScope: SpinScopeResolver<'friends'> = {
  kind: 'friends', provides: ['store', 'achievements', 'group'],
  resolve: (scope, ctx) => resolveGroup(scope.with, ctx),
};
export const pairScope: SpinScopeResolver<'pair'> = {
  kind: 'pair', provides: ['store', 'achievements', 'group'],
  resolve: (scope, ctx) => resolveGroup([scope.with], ctx),
};
