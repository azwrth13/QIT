import { db } from './firestore';
import type { Game } from './games';
import { getSteamGames, type SteamProfile } from './steam';
import { getGenresForApps } from './genre-cache';

export const AUTO_SYNC_COOKIE = 'library-autosync';

export async function getStoredProfile(steamId: string): Promise<SteamProfile | null> {
  const snapshot = await db.collection('users').doc(steamId).get();
  return snapshot.exists ? snapshot.data() as SteamProfile : null;
}

export async function getLastSyncedAt(steamId: string): Promise<string | null> {
  const snapshot = await db.collection('users').doc(steamId).get();
  return snapshot.data()?.lastSyncedAt || null;
}

export async function getStoredGames(steamId: string): Promise<Game[]> {
  const snapshot = await db.collection('users').doc(steamId).collection('games').get();
  const games = snapshot.docs.map(doc => doc.data() as Game);
  const genres = await getGenresForApps(games.map(game => game.appid), 40);
  return games.map(game => ({ ...game, genres: genres[game.appid] || [] }));
}

export async function syncLibrary(steamId: string, profile: SteamProfile): Promise<{ games: Game[]; lastSynced: string } | null> {
  const games = await getSteamGames(steamId);
  if (games === null) return null;
  const userRef = db.collection('users').doc(steamId);
  const gamesRef = userRef.collection('games');
  const existing = await gamesRef.get();
  const incoming = new Map(games.map(game => [String(game.appid), {
    appid: game.appid, name: game.name, img_icon_url: game.img_icon_url || '',
    playtime_forever: game.playtime_forever || 0,
  }]));
  const writes: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [];
  for (const doc of existing.docs) {
    const next = incoming.get(doc.id);
    if (!next) writes.push(batch => batch.delete(doc.ref));
    else {
      const stored = doc.data();
      if (stored.appid !== next.appid || stored.name !== next.name ||
          stored.img_icon_url !== next.img_icon_url || stored.playtime_forever !== next.playtime_forever) {
        writes.push(batch => batch.set(doc.ref, next));
      }
    }
    incoming.delete(doc.id);
  }
  for (const [id, game] of incoming) writes.push(batch => batch.set(gamesRef.doc(id), game));
  for (let offset = 0; offset < writes.length; offset += 450) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + 450)) write(batch);
    await batch.commit();
  }
  const lastSynced = new Date().toISOString();
  await userRef.set({ ...profile, lastSyncedAt: lastSynced }, { merge: true });
  const genres = await getGenresForApps(games.map(game => game.appid), 40);
  return { games: games.map(game => ({ ...game, genres: genres[game.appid] || [] })), lastSynced };
}

export async function ensureUser(steamId: string, profile: SteamProfile) {
  await db.collection('users').doc(steamId).set(profile, { merge: true });
}
