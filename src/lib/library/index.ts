import type { WriteBatch } from 'firebase-admin/firestore';
import { db } from '../firestore';
import type { Game } from '../games';
import { logServerError, type SteamProfile } from '../steam';
import { detectPlayedRolls } from '../history/played';
import { getOwnedGames } from '../steam/owned';
import { patchLibIndex, readLibIndex, removeFromLibIndex } from '../store/lib-index';
import { paths } from '../store/paths';
import { commitInBatches } from '../store/tx';
import type { LibIndexEntry, UserRecord } from '../store/types';
import { detectPlaytimeHidden, fromGameDoc, fromIndexEntry, fromOwnedGame, planSync, toGameDoc } from './model';

export * from './model';

// A user's library. The library index (`users/{id}/libIndex/*`, four reads) is the read path; the per-game documents
// are still written on every sync so a later cleanup can drop them, and are read only for users whose index has not
// been built yet (synced before it existed), until their next sync rebuilds it.

export interface Library {
  games: Game[];
  /** `legacy` means the index is not built yet and the games came from per-game documents. */
  source: 'index' | 'legacy';
  /** Steam reports no playtime at all for this user, so playtime-based modes cannot work (see `detectPlaytimeHidden`). */
  playtimeHidden: boolean;
  lastSyncedAt: string | null;
}

const byAppId = (a: Game, b: Game) => a.appid - b.appid;
const isAppId = (id: number) => Number.isSafeInteger(id) && id > 0;

async function legacyGames(steamId: string): Promise<Game[]> {
  const snapshot = await db.collection(paths.userGames(steamId)).get();
  return snapshot.docs.map(doc => fromGameDoc(doc.data())).filter((game): game is Game => game !== null);
}

export async function getLibraryGames(steamId: string): Promise<Pick<Library, 'games' | 'source'>> {
  const index = await readLibIndex(steamId);
  if (!index.built) return { games: (await legacyGames(steamId)).sort(byAppId), source: 'legacy' };
  return { games: [...index.entries].map(([appid, entry]) => fromIndexEntry(appid, entry)).sort(byAppId), source: 'index' };
}

export async function getLibrary(steamId: string): Promise<Library> {
  const [user, { games, source }] = await Promise.all([db.doc(paths.user(steamId)).get(), getLibraryGames(steamId)]);
  const data = user.data() as Partial<UserRecord> | undefined;
  return {
    games, source,
    playtimeHidden: data?.flags?.playtimeHidden === true,
    lastSyncedAt: typeof data?.lastSyncedAt === 'string' ? data.lastSyncedAt : null,
  };
}

export async function ownsGames(steamId: string, appids: number[]): Promise<boolean> {
  const index = await readLibIndex(steamId);
  if (index.built) return appids.every(appid => index.entries.has(appid));
  if (!appids.length) return true;
  if (!appids.every(isAppId)) return false;
  const snapshots = await db.getAll(...appids.map(appid => db.doc(paths.userGame(steamId, appid))));
  return snapshots.every(snapshot => snapshot.exists);
}

/**
 * Pulls the library from Steam and writes what changed: per-game documents first, then the index, so an interrupted
 * sync leaves the index behind and the next sync redoes the diff. Returns null when Steam does not share the games.
 */
export async function syncLibrary(steamId: string, profile: SteamProfile): Promise<{ games: Game[]; lastSynced: string; playtimeHidden: boolean } | null> {
  const owned = await getOwnedGames(steamId);
  if (owned.state === 'private') return null;
  const games = owned.games.map(fromOwnedGame);
  const index = await readLibIndex(steamId);
  // Before the index exists, the stored per-game documents are the only record of which games to delete.
  const previous: ReadonlyMap<number, LibIndexEntry | undefined> = index.built ? index.entries
    : new Map((await db.collection(paths.userGames(steamId)).select().get()).docs
      .map(doc => Number(doc.id)).filter(isAppId).map(appid => [appid, undefined]));
  const plan = planSync(games, previous);
  const writes: Array<(batch: WriteBatch) => void> = [
    ...plan.changed.map(game => (batch: WriteBatch) => { batch.set(db.doc(paths.userGame(steamId, game.appid)), toGameDoc(game)); }),
    ...plan.removed.map(appid => (batch: WriteBatch) => { batch.delete(db.doc(paths.userGame(steamId, appid))); }),
  ];
  await commitInBatches(writes);
  if (plan.patches.size) await patchLibIndex(steamId, plan.patches, { create: true });
  if (index.built && plan.removed.length) await removeFromLibIndex(steamId, plan.removed);
  const lastSynced = new Date().toISOString();
  const playtimeHidden = detectPlaytimeHidden(games);
  await db.doc(paths.user(steamId)).set({ ...profile, lastSyncedAt: lastSynced, flags: { playtimeHidden } }, { merge: true });
  // All sync callers (refresh and autosync) detect after the index and profile have been persisted. Detection
  // is best effort: a later sync retries against each roll's original baseline even when the library is unchanged.
  try {
    await detectPlayedRolls(steamId, { games, playtimeHidden }, Date.parse(lastSynced));
  } catch (error) {
    logServerError('Played detection failed', error);
  }
  return { games: games.sort(byAppId), lastSynced, playtimeHidden };
}
