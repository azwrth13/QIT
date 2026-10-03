import { db } from '../firestore';
import { compareLibraries, type GroupLibrary } from '../group/libraries';
import { getLibraryGames } from '../library';
import { getLibraryFor, type FriendLibrary } from '../social/libraries';
import { isSteamId } from '../steam';
import { getPlayerSummaries, type PlayerSummary } from '../steam/players';
import { readLibIndex } from '../store/lib-index';
import { paths } from '../store/paths';
import type { LibIndexEntry, UserRecord } from '../store/types';
import { CompareError, type CompareOptions, type CompareResult } from './types';

export interface CompareDeps {
  getLibraryFor: (ids: readonly string[]) => Promise<FriendLibrary[]>;
  getPlayerSummaries: (ids: readonly string[]) => Promise<Map<string, PlayerSummary>>;
  getRequesterLibrary: (steamId: string) => Promise<GroupLibrary>;
  getTargetPlaytimeHidden: (steamId: string) => Promise<boolean>;
  now: () => number;
}

async function defaultRequesterLibrary(steamId: string): Promise<GroupLibrary> {
  const [userDoc, index] = await Promise.all([
    db.doc(paths.user(steamId)).get(),
    readLibIndex(steamId),
  ]);
  const flags = (userDoc.data() as Partial<UserRecord> | undefined)?.flags;
  const playtimeHidden = flags?.playtimeHidden === true;
  let games: Map<number, LibIndexEntry>;
  if (index.built && index.entries.size > 0) {
    games = index.entries;
  } else {
    const legacy = await getLibraryGames(steamId);
    if (legacy.games.length > 0) {
      games = new Map();
      for (const g of legacy.games) {
        games.set(g.appid, {
          n: g.name,
          i: g.img_icon_url || '',
          p: g.playtime_forever,
          w: g.playtime_2weeks ?? 0,
          ...(g.rtime_last_played ? { r: g.rtime_last_played } : {}),
        });
      }
    } else {
      const [fetched] = await getLibraryFor([steamId]);
      games = fetched?.games ?? new Map();
    }
  }
  return { steamId, games, playtimeHidden, state: 'ok' };
}

async function defaultTargetPlaytimeHidden(steamId: string): Promise<boolean> {
  try {
    const targetUserDoc = await db.doc(paths.user(steamId)).get();
    const flags = (targetUserDoc.data() as Partial<UserRecord> | undefined)?.flags;
    return flags?.playtimeHidden === true;
  } catch {
    return false;
  }
}

export async function compareLibrariesService(
  requesterSteamId: string,
  targetSteamId: string,
  options: CompareOptions = {},
  depsOverride: Partial<CompareDeps> = {}
): Promise<CompareResult> {
  if (!isSteamId(targetSteamId)) {
    throw new CompareError('invalid', 'Enter a valid 17-digit Steam ID.', 400);
  }
  if (!isSteamId(requesterSteamId)) {
    throw new CompareError('invalid', 'Invalid requester Steam ID.', 400);
  }
  if (targetSteamId === requesterSteamId) {
    throw new CompareError('invalid', 'Cannot compare your library with yourself.', 400);
  }

  const deps: CompareDeps = {
    getLibraryFor,
    getPlayerSummaries,
    getRequesterLibrary: defaultRequesterLibrary,
    getTargetPlaytimeHidden: defaultTargetPlaytimeHidden,
    now: () => Math.floor(Date.now() / 1000),
    ...depsOverride,
  };

  const [targetLibs, summaries, userLibrary] = await Promise.all([
    deps.getLibraryFor([targetSteamId]),
    deps.getPlayerSummaries([targetSteamId, requesterSteamId]),
    deps.getRequesterLibrary(requesterSteamId),
  ]);

  const targetLib = targetLibs[0];
  if (!targetLib || targetLib.state === 'not_found') {
    throw new CompareError('not_found', 'Steam profile not found.', 404);
  }
  if (targetLib.state === 'private') {
    throw new CompareError('forbidden', 'This friend’s game details are private. Ask them to set Game details to Public in Steam.', 403);
  }
  if (targetLib.state === 'error') {
    throw new CompareError('unavailable', 'Could not load this friend’s library. Please try again.', 502);
  }

  const targetPlaytimeHidden = await deps.getTargetPlaytimeHidden(targetSteamId);

  const targetLibrary: GroupLibrary = {
    steamId: targetSteamId,
    games: targetLib.games,
    playtimeHidden: targetPlaytimeHidden,
    state: 'ok',
  };

  const now = options.now ?? deps.now();
  const comparison = compareLibraries(userLibrary, targetLibrary, {
    now,
    notRecentlyPlayedDays: options.notRecentlyPlayedDays,
  });

  const targetSummary = summaries.get(targetSteamId);
  const userSummary = summaries.get(requesterSteamId);

  return {
    target: {
      steamId: targetSteamId,
      personaName: targetSummary?.personaname ?? targetSteamId,
      avatarUrl: targetSummary?.avatarmedium || targetSummary?.avatar || null,
      profileUrl: targetSummary?.profileurl || `https://steamcommunity.com/profiles/${targetSteamId}`,
    },
    user: {
      steamId: requesterSteamId,
      personaName: userSummary?.personaname,
      avatarUrl: userSummary?.avatarmedium || userSummary?.avatar || null,
    },
    sharedCount: comparison.both.length,
    both: comparison.both,
    onlyMe: comparison.onlyA,
    onlyThem: comparison.onlyB,
    neitherRecentlyPlayed: comparison.neitherRecentlyPlayed,
    oneNeverPlayed: comparison.oneNeverPlayed,
    playtimeHidden: {
      me: userLibrary.playtimeHidden ?? false,
      them: targetPlaytimeHidden,
    },
    onlyA: comparison.onlyA,
    onlyB: comparison.onlyB,
  };
}
