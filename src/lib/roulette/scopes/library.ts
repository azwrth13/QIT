import { decodeStoreFlags, isNonGame } from '../../apps/metadata';
import { db } from '../../firestore';
import { lastPlayedAt, type Game } from '../../games';
import { getLibraryGames } from '../../library';
import { readLibIndex } from '../../store/lib-index';
import { paths } from '../../store/paths';
import type { LibIndexEntry, UserRecord } from '../../store/types';
import type { SpinScopeResult } from '../pipeline';
import type { Candidate, ScopeResolver, Signals, StoreSignals } from '../types';

// The `library` scope: the requester's own games, read from the library index (four reads plus the user document).
// Besides the library signals, the index already holds the store flag bits (`f`, app-metadata) and the achievement
// summary (`ap`/`au`/`at`, achievements-data), so those families are attached here without further reads.

/**
 * The store type given to a game whose flag bits say "not a game". The bits do not keep the exact type, only that it
 * is known and is not `game`, so any type the exclusion stage hides (`NON_GAME_TYPES`) would do.
 */
export const INDEXED_NON_GAME_TYPE = 'application';

const minutes = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const isAppId = (appid: number) => Number.isSafeInteger(appid) && appid > 0;

/** Store signals from the index's flag bits. Only flags and the non-game bit are known; the rest comes from `appMeta`. */
export function storeSignalsFromBits(bits: number): StoreSignals {
  return { type: isNonGame(bits) ? INDEXED_NON_GAME_TYPE : null, flags: decodeStoreFlags(bits), releasedAt: null, tagIds: [], headerArt: null };
}

/** A candidate from one library index entry. A family the entry has no data for is left out (not loaded). */
export function candidateFromIndexEntry(appid: number, entry: LibIndexEntry): Candidate {
  const playtime = minutes(entry.p);
  const signals: Signals = {
    library: {
      name: entry.n,
      iconHash: entry.i || null,
      playtimeForever: playtime,
      playtime2Weeks: entry.w === undefined ? null : minutes(entry.w),
      lastPlayedAt: lastPlayedAt(entry.r, playtime),
    },
  };
  if (typeof entry.f === 'number') signals.store = storeSignalsFromBits(entry.f);
  if (entry.at === 0) signals.achievements = null;
  else if (typeof entry.at === 'number' && entry.at > 0 && typeof entry.au === 'number') {
    signals.achievements = {
      total: entry.at,
      unlocked: entry.au,
      percent: typeof entry.ap === 'number' ? entry.ap : entry.au / entry.at * 100,
      lockedRare: null,
      lastUnlockAt: null,
    };
  }
  return { appid, signals };
}

/** A candidate from a legacy per-game document (index not built yet): library signals only. */
export function candidateFromGame(game: Game): Candidate {
  const playtime = minutes(game.playtime_forever);
  return {
    appid: game.appid,
    signals: {
      library: {
        name: game.name,
        iconHash: game.img_icon_url || null,
        playtimeForever: playtime,
        playtime2Weeks: game.playtime_2weeks === undefined ? null : minutes(game.playtime_2weeks),
        lastPlayedAt: lastPlayedAt(game.rtime_last_played, playtime),
      },
    },
  };
}

export const libraryScope: ScopeResolver<'library'> = {
  kind: 'library',
  async resolve(_scope, { steamId }): Promise<SpinScopeResult> {
    const [user, index] = await Promise.all([db.doc(paths.user(steamId)).get(), readLibIndex(steamId)]);
    const flags = (user.data() as Partial<UserRecord> | undefined)?.flags;
    // Until the next sync builds the index, users who synced before it existed still have per-game documents.
    const candidates = index.built
      ? [...index.entries].filter(([appid]) => isAppId(appid)).map(([appid, entry]) => candidateFromIndexEntry(appid, entry))
      : (await getLibraryGames(steamId)).games.filter(game => isAppId(game.appid)).map(candidateFromGame);
    return { candidates, members: [steamId], unavailable: [], playtimeHidden: flags?.playtimeHidden === true };
  },
};
