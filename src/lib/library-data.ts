import { db } from './firestore';
import type { Game } from './games';
import type { SteamProfile } from './steam';
import { getLibraryGames } from './library';

export { ownsGames, syncLibrary } from './library';

export async function getStoredProfile(steamId: string): Promise<SteamProfile | null> {
  const snapshot = await db.collection('users').doc(steamId).get();
  return snapshot.exists ? snapshot.data() as SteamProfile : null;
}

export async function getLastSyncedAt(steamId: string): Promise<string | null> {
  const snapshot = await db.collection('users').doc(steamId).get();
  return snapshot.data()?.lastSyncedAt || null;
}

// Reads the library index (four reads). Genres are not filled here: the client loads them through /api/games/genres.
export async function getStoredGames(steamId: string): Promise<Game[]> {
  return (await getLibraryGames(steamId)).games;
}

export async function ensureUser(steamId: string, profile: SteamProfile) {
  await db.collection('users').doc(steamId).set(profile, { merge: true });
}
