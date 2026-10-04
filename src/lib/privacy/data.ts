import { createHash } from 'node:crypto';
import { FieldPath, type DocumentReference } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { removeLobbyMemberForDeletion } from '../lobby/service';
import { paths } from '../store/paths';
import { commitInBatches } from '../store/tx';
import type { LobbyRecord } from '../store/types';

const createLimitPath = (steamId: string) => paths.lobbyLimit(`create-${createHash('sha256').update(steamId).digest('hex')}`);
const memberships = (steamId: string) => db.collection(paths.lobbies())
  .where(new FieldPath('members', steamId, 'state'), 'in', ['present', 'ready', 'away']);

/** listDocuments includes missing parent documents with descendants, unlike a collection query. */
async function visitTree(ref: DocumentReference, visit: (ref: DocumentReference) => Promise<void>): Promise<void> {
  for (const collection of await ref.listCollections()) {
    for (const child of await collection.listDocuments()) await visitTree(child, visit);
  }
  await visit(ref);
}

/** Only the caller's tree and their own entries from shared storage; never another user's tree or lobby library. */
export async function exportUserData(steamId: string) {
  const root = db.doc(paths.user(steamId));
  const documents: Record<string, unknown> = {};
  await visitTree(root, async ref => {
    const snapshot = await ref.get();
    if (snapshot.exists) documents[ref.path.slice(root.path.length + 1) || '.'] = snapshot.data();
  });
  const publicLibrary = (await db.doc(paths.publicLibrary(steamId)).get()).data() ?? null;
  const creationLimit = (await db.doc(createLimitPath(steamId)).get()).data() ?? null;
  const lobbies = (await memberships(steamId).get()).docs.map(snapshot => {
    const lobby = snapshot.data() as LobbyRecord;
    return { code: snapshot.id, member: lobby.members[steamId], isHost: lobby.hostId === steamId,
      status: lobby.status, createdAt: lobby.createdAt, expiresAt: lobby.expiresAt };
  });
  return { version: 1, steamId, exportedAt: new Date().toISOString(), documents, publicLibrary, creationLimit, lobbies };
}

/** Retry-safe partial progress: remove shared copies first, then descendants before their parent. */
export async function deleteUserData(steamId: string): Promise<void> {
  const lobbies = await memberships(steamId).get();
  for (const lobby of lobbies.docs) await removeLobbyMemberForDeletion(lobby.id, steamId);
  const refs: DocumentReference[] = [];
  await visitTree(db.doc(paths.user(steamId)), async ref => { refs.push(ref); });
  refs.push(db.doc(paths.publicLibrary(steamId)), db.doc(createLimitPath(steamId)));
  await commitInBatches(refs.map(ref => batch => { batch.delete(ref); }));
}
