import { Timestamp } from 'firebase-admin/firestore';
import { logServerError } from '../steam';
import { getFriendList, getPlayerSummaries, type PlayerSummary } from '../steam/players';
import type { FriendsMetaRecord, FriendSummaryRecord } from '../store/types';
import { bestEffort, resolveDeps, type ResolvedDeps, type SocialDeps } from './deps';

// The requester's friends for the home page suggestions and, later, the friend dashboard and Friend Night.
// `users/{id}/meta/friends` holds a snapshot that is reused for 15 minutes. It is written only here. When the
// friends list is private, the players the user pinned (D11) take the friends' place.

export const FRIENDS_TTL_MS = 15 * 60 * 1000;

export const PRIVATE_LIST_MESSAGE = 'Your Steam friends list is private. Make your friends list public in Steam to see suggestions.';
export const PINNED_MESSAGE = 'Your Steam friends list is private, so these are the players you pinned.';
export const NO_FRIENDS_MESSAGE = 'No Steam friends to suggest yet.';

/** Steam `personastate` values. */
export const PERSONA_STATES = ['offline', 'online', 'busy', 'away', 'snooze', 'looking to trade', 'looking to play'] as const;

export interface FriendProfile {
  steamId: string;
  personaName: string;
  profileUrl: string;
  avatarFull: string;
  avatarMedium: string;
  /** Steam `personastate` (index into `PERSONA_STATES`). Absent when Steam does not share it. */
  status?: number;
  /** The game being played right now, when Steam shows it. `appid` is null for a non-Steam game. */
  currentGame?: { appid: number | null; name: string };
}

export interface FriendsResult {
  friends: FriendProfile[];
  /** Set when there is something to tell the user, for example that the list is private. */
  message?: string;
  /** `pinned` when the friends list is private and the players are the ones the user pinned. */
  source: 'friends' | 'pinned';
}

export function toSummaryRecord(player: PlayerSummary): FriendSummaryRecord {
  const gameId = Number(player.gameid);
  const record: FriendSummaryRecord = {
    name: typeof player.personaname === 'string' ? player.personaname : '',
    url: typeof player.profileurl === 'string' ? player.profileurl : '',
    avatar: player.avatarfull ?? player.avatarmedium ?? player.avatar ?? '',
  };
  if (typeof player.avatarmedium === 'string') record.avatarMedium = player.avatarmedium;
  if (typeof player.personastate === 'number' && Number.isInteger(player.personastate) && player.personastate >= 0) record.status = player.personastate;
  if (Number.isSafeInteger(gameId) && gameId > 0) record.gameId = gameId;
  if (typeof player.gameextrainfo === 'string' && player.gameextrainfo) record.game = player.gameextrainfo;
  return record;
}

export function toProfile(steamId: string, summary: FriendSummaryRecord): FriendProfile {
  const profile: FriendProfile = {
    steamId, personaName: summary.name, profileUrl: summary.url,
    avatarFull: summary.avatar, avatarMedium: summary.avatarMedium ?? summary.avatar,
  };
  if (summary.status !== undefined) profile.status = summary.status;
  if (summary.game !== undefined) profile.currentGame = { appid: summary.gameId ?? null, name: summary.game };
  return profile;
}

function present(ids: readonly string[], summaries: Record<string, FriendSummaryRecord>): FriendProfile[] {
  // A friend without a summary is a deleted or banned account and is left out.
  return ids.flatMap(id => summaries[id] ? [toProfile(id, summaries[id])] : []);
}

function toResult(record: FriendsMetaRecord, pinned: readonly string[]): FriendsResult {
  if (record.state === 'ok') {
    const result: FriendsResult = { friends: present(record.ids, record.summaries), source: 'friends' };
    if (record.ids.length === 0) result.message = NO_FRIENDS_MESSAGE;
    return result;
  }
  const friends = present(pinned, record.summaries);
  return friends.length ? { friends, message: PINNED_MESSAGE, source: 'pinned' } : { friends, message: PRIVATE_LIST_MESSAGE, source: 'friends' };
}

function summariesOf(players: Map<string, PlayerSummary>): Record<string, FriendSummaryRecord> {
  return Object.fromEntries([...players].map(([id, player]) => [id, toSummaryRecord(player)]));
}

async function refresh(steamId: string, snapshot: FriendsMetaRecord | null, deps: ResolvedDeps): Promise<FriendsResult> {
  const { store, client, now } = deps;
  const age = snapshot ? now() - snapshot.fetchedAt.toMillis() : Infinity;
  let pinned: string[] = [];
  try {
    if (snapshot && age >= 0 && age < FRIENDS_TTL_MS) {
      if (snapshot.state === 'ok') return toResult(snapshot, []);
      pinned = await store.readPinned(steamId);
      // `ids` lists the pinned players already looked up, so an account Steam no longer knows is not asked for again.
      const missing = pinned.filter(id => !snapshot.ids.includes(id));
      if (missing.length === 0) return toResult(snapshot, pinned);
      // Newly pinned players: fetch only their summaries. `fetchedAt` stays, so the rest still expires on time.
      const record: FriendsMetaRecord = {
        ...snapshot, ids: [...snapshot.ids, ...missing], summaries: { ...snapshot.summaries, ...summariesOf(await getPlayerSummaries(missing, client)) },
      };
      await bestEffort('Friends snapshot write failed', () => store.writeFriends(steamId, record), undefined);
      return toResult(record, pinned);
    }
    const list = await getFriendList(steamId, client);
    if (list.state === 'private') pinned = await store.readPinned(steamId);
    const ids = list.state === 'public' ? list.friends.map(friend => friend.steamid) : pinned;
    const players = ids.length ? await getPlayerSummaries(ids, client) : new Map<string, PlayerSummary>();
    const record: FriendsMetaRecord = {
      ids, summaries: summariesOf(players), state: list.state === 'public' ? 'ok' : 'private', fetchedAt: Timestamp.fromMillis(now()),
    };
    await bestEffort('Friends snapshot write failed', () => store.writeFriends(steamId, record), undefined);
    return toResult(record, pinned);
  } catch (error) {
    // Steam is failing or rate limiting: an old snapshot is better than an error.
    if (!snapshot) throw error;
    logServerError('Steam friends refresh failed, serving the last snapshot', error);
    return toResult(snapshot, snapshot.state === 'private' ? pinned : []);
  }
}

const inflight = new Map<string, Promise<FriendsResult>>();

/**
 * The requester's friends with their status and current game. Served from the Firestore snapshot for 15
 * minutes, then refreshed from Steam. A failed refresh serves the stale snapshot when there is one. Concurrent
 * calls for one user share a single refresh on this instance.
 */
export function getFriends(steamId: string, socialDeps: SocialDeps = {}): Promise<FriendsResult> {
  const existing = inflight.get(steamId);
  if (existing) return existing;
  const deps = resolveDeps(socialDeps);
  const task = (async () => refresh(steamId, await bestEffort('Friends snapshot read failed', () => deps.store.readFriends(steamId), null), deps))();
  inflight.set(steamId, task);
  const clear = () => { if (inflight.get(steamId) === task) inflight.delete(steamId); };
  task.then(clear, clear);
  return task;
}
