import { lastPlayedAt } from '../games';
import { playedWithin } from '../roulette/filters/recency';
import { THRESHOLDS } from '../roulette/thresholds';
import type { GroupMemberSignals } from '../roulette/types';
import type { LibIndexEntry } from '../store/types';

/** Structural input: social FriendLibrary fits; callers attach the user's hidden-playtime flag. */
export interface GroupLibrary {
  steamId: string;
  games: ReadonlyMap<number, LibIndexEntry>;
  playtimeHidden?: boolean;
  state?: 'ok' | 'private' | 'not_found' | 'error';
}

export interface GroupGameMember extends GroupMemberSignals {
  playtime2Weeks: number | null;
  lastPlayedAt: number | null;
}

export interface GroupGame {
  appid: number;
  /** Metadata comes from the first owner in input order. */
  name: string;
  iconHash: string | null;
  group: { members: GroupGameMember[] };
  owners: string[];
  /** Minutes; non-owners and players with hidden or missing playtime have null. */
  playtimeByPlayer: Record<string, number | null>;
  playedBy: string[];
  neverPlayedBy: string[];
  unknownPlaytimeBy: string[];
}

const minutes = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function validate(libraries: readonly GroupLibrary[]): void {
  const ids = new Set<string>();
  for (const library of libraries) {
    if (!library.steamId || ids.has(library.steamId)) throw new Error('Group players must have distinct nonempty IDs');
    if (library.state !== undefined && library.state !== 'ok') throw new Error('Group library is unavailable');
    ids.add(library.steamId);
  }
}

function gameFor(appid: number, libraries: readonly GroupLibrary[]): GroupGame {
  const first = libraries.find(library => library.games.has(appid))!.games.get(appid)!;
  const members: GroupGameMember[] = libraries.map(library => {
    const entry = library.games.get(appid);
    const p = entry && !library.playtimeHidden ? minutes(entry.p) : null;
    return {
      steamId: library.steamId, owns: entry !== undefined, playtimeForever: p,
      playtime2Weeks: entry && !library.playtimeHidden ? minutes(entry.w) : null,
      lastPlayedAt: entry && !library.playtimeHidden ? lastPlayedAt(entry.r, p ?? 0) : null,
    };
  });
  const owners = members.filter(member => member.owns);
  return {
    appid, name: first.n, iconHash: first.i || null, group: { members },
    owners: owners.map(member => member.steamId),
    playtimeByPlayer: Object.fromEntries(members.map(member => [member.steamId, member.playtimeForever])),
    playedBy: owners.filter(member => member.playtimeForever !== null && member.playtimeForever > 0).map(member => member.steamId),
    neverPlayedBy: owners.filter(member => member.playtimeForever === 0).map(member => member.steamId),
    unknownPlaytimeBy: owners.filter(member => member.playtimeForever === null).map(member => member.steamId),
  };
}

/** Empty input yields no games; one player yields their library. Unavailable players must be resolved by the caller. */
export function intersect(libraries: readonly GroupLibrary[]): GroupGame[] {
  validate(libraries);
  if (!libraries.length) return [];
  return [...libraries[0].games.keys()]
    .filter(appid => libraries.every(library => library.games.has(appid)))
    .sort((a, b) => a - b).map(appid => gameFor(appid, libraries));
}

export interface ComparisonOptions {
  /** Unix seconds; supplied by the caller to keep comparison pure. */
  now: number;
  notRecentlyPlayedDays?: number;
}

export interface LibraryComparison {
  both: GroupGame[];
  onlyA: GroupGame[];
  onlyB: GroupGame[];
  neitherRecentlyPlayed: GroupGame[];
  /** Shared games where at least one player is known to have never played. Includes both never played. */
  oneNeverPlayed: GroupGame[];
}

export function compareLibraries(a: GroupLibrary, b: GroupLibrary, options: ComparisonOptions): LibraryComparison {
  validate([a, b]);
  const days = options.notRecentlyPlayedDays ?? THRESHOLDS.notRecentlyPlayedDays;
  if (!Number.isFinite(options.now) || options.now < 0 || !Number.isFinite(days) || days <= 0) {
    throw new RangeError('Comparison needs a nonnegative time and positive recency window');
  }
  const union = [...new Set([...a.games.keys(), ...b.games.keys()])].sort((x, y) => x - y)
    .map(appid => gameFor(appid, [a, b]));
  const both = union.filter(game => game.owners.length === 2);
  return {
    both,
    onlyA: union.filter(game => game.owners.length === 1 && game.owners[0] === a.steamId),
    onlyB: union.filter(game => game.owners.length === 1 && game.owners[0] === b.steamId),
    neitherRecentlyPlayed: both.filter(game => game.group.members.every(member =>
      member.playtimeForever !== null && playedWithin({
        name: game.name, iconHash: game.iconHash, playtimeForever: member.playtimeForever,
        playtime2Weeks: member.playtime2Weeks, lastPlayedAt: member.lastPlayedAt,
      }, days, options.now) === 'outside')),
    oneNeverPlayed: both.filter(game => game.neverPlayedBy.length > 0),
  };
}
