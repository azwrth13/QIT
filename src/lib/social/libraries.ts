import { Timestamp } from 'firebase-admin/firestore';
import { isSteamId, logServerError } from '../steam';
import { SteamClientError } from '../steam/client';
import { getOwnedGames } from '../steam/owned';
import { getPlayerSummaries } from '../steam/players';
import type { LibIndexEntry, PublicLibraryRecord } from '../store/types';
import { bestEffort, resolveDeps, type ResolvedDeps, type SocialDeps } from './deps';

// Other players' libraries for Friend Night, the lobby, comparison and the friend dashboard. A QIT user's library
// comes from their library index, which costs four reads. Everyone else comes live from Steam and is kept in
// `publicLibraries/{steamId}` for 30 minutes (D10), so a group asking again does not call Steam again.
// Each player has a state, so one private profile never fails the whole group.

/** How long a non-QIT library is reused (D10). */
export const PUBLIC_LIBRARY_TTL_MS = 30 * 60 * 1000;
/** A private or missing profile is checked again sooner, so a friend who fixes their privacy settings is not stuck. */
export const NEGATIVE_TTL_MS = 5 * 60 * 1000;
/** Steam failed: remembered only briefly, to stop a retry storm while it is down. */
export const ERROR_TTL_MS = 60 * 1000;
/** Most players in one call. Group features are capped far below this. */
export const MAX_LIBRARY_IDS = 50;

export type LibraryState = 'ok' | 'private' | 'not_found' | 'error';

export interface FriendLibrary {
  steamId: string;
  state: LibraryState;
  /** `qit` for a QIT user's library index, `steam` for a library fetched from Steam (now or up to 30 minutes ago). */
  source: 'qit' | 'steam';
  /** Games by appid. Empty unless `state` is `ok`. */
  games: Map<number, LibIndexEntry>;
  /** When the data was read (ms): the index's last write, or the Steam fetch. Null when unknown. */
  fetchedAt: number | null;
}

const ttlFor = (state: LibraryState) => state === 'ok' ? PUBLIC_LIBRARY_TTL_MS : state === 'error' ? ERROR_TTL_MS : NEGATIVE_TTL_MS;

type Row = [appid: number, name: string, icon: string, playtime: number, playtime2Weeks: number, lastPlayed: number | null];

/** Compact JSON for the cache document: one array per game. Exported for tests. */
export function encodeGames(games: Map<number, LibIndexEntry>): string {
  const rows: Row[] = [...games].map(([appid, game]) => [appid, game.n, game.i ?? '', game.p ?? 0, game.w ?? 0, game.r ?? null]);
  return JSON.stringify(rows);
}

/** Returns null when the text is not something `encodeGames` wrote. Malformed rows are skipped. Exported for tests. */
export function decodeGames(json: string): Map<number, LibIndexEntry> | null {
  let rows: unknown;
  try { rows = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const games = new Map<number, LibIndexEntry>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const [appid, name, icon, playtime, playtime2Weeks, lastPlayed] = row as unknown[];
    if (typeof appid !== 'number' || !Number.isSafeInteger(appid) || appid <= 0 || typeof name !== 'string') continue;
    const game: LibIndexEntry = { n: name };
    if (typeof icon === 'string' && icon) game.i = icon;
    if (typeof playtime === 'number' && Number.isFinite(playtime)) game.p = playtime;
    if (typeof playtime2Weeks === 'number' && Number.isFinite(playtime2Weeks)) game.w = playtime2Weeks;
    if (typeof lastPlayed === 'number' && Number.isFinite(lastPlayed)) game.r = lastPlayed;
    games.set(appid, game);
  }
  return games;
}

function fromRecord(steamId: string, record: PublicLibraryRecord): FriendLibrary | null {
  let games = new Map<number, LibIndexEntry>();
  if (record.state === 'ok') {
    const decoded = decodeGames(record.games);
    if (!decoded) return null;
    games = decoded;
  }
  return { steamId, state: record.state, source: 'steam', games, fetchedAt: record.fetchedAt.toMillis() };
}

async function fetchFromSteam(steamId: string, { client, now }: ResolvedDeps): Promise<FriendLibrary> {
  const result = (state: LibraryState, games = new Map<number, LibIndexEntry>()): FriendLibrary =>
    ({ steamId, state, source: 'steam', games, fetchedAt: now() });
  try {
    const player = (await getPlayerSummaries([steamId], client)).get(steamId);
    if (!player) return result('not_found');
    // Steam shows game details only on a public profile.
    if (player.communityvisibilitystate !== 3) return result('private');
    const owned = await getOwnedGames(steamId, client);
    if (owned.state === 'private') return result('private');
    const games = new Map<number, LibIndexEntry>();
    for (const game of owned.games) {
      const entry: LibIndexEntry = { n: game.name, p: game.playtime_forever, w: game.playtime_2weeks };
      if (game.img_icon_url) entry.i = game.img_icon_url;
      if (game.rtime_last_played !== null) entry.r = game.rtime_last_played;
      games.set(game.appid, entry);
    }
    return result('ok', games);
  } catch (error) {
    if (error instanceof SteamClientError && error.kind === 'not_found') return result('not_found');
    logServerError('Friend library request failed', error);
    return result('error');
  }
}

const inflight = new Map<string, Promise<FriendLibrary>>();

/** One live fetch per player at a time on this instance, cached when it finishes. */
function loadLive(steamId: string, deps: ResolvedDeps): Promise<FriendLibrary> {
  const existing = inflight.get(steamId);
  if (existing) return existing;
  const task = (async () => {
    const library = await fetchFromSteam(steamId, deps);
    const fetchedAt = library.fetchedAt ?? deps.now();
    const record: PublicLibraryRecord = {
      state: library.state,
      games: library.state === 'ok' ? encodeGames(library.games) : '',
      fetchedAt: Timestamp.fromMillis(fetchedAt),
      expiresAt: Timestamp.fromMillis(fetchedAt + ttlFor(library.state)),
    };
    await bestEffort('Public library cache write failed', () => deps.store.writePublicLibrary(steamId, record), undefined);
    return library;
  })();
  inflight.set(steamId, task);
  const clear = () => { if (inflight.get(steamId) === task) inflight.delete(steamId); };
  task.then(clear, clear);
  return task;
}

/**
 * The libraries of the given players, in the order given (repeated ids once). QIT users come from the library
 * index; everyone else comes from the 30-minute cache or live from Steam. A player whose library cannot be read
 * gets a state (`private`, `not_found` or `error`) and no games; the call itself only throws for invalid input.
 */
export async function getLibraryFor(ids: readonly string[], socialDeps: SocialDeps = {}): Promise<FriendLibrary[]> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_LIBRARY_IDS) throw new RangeError(`At most ${MAX_LIBRARY_IDS} players per request`);
  if (!unique.every(isSteamId)) throw new Error('Invalid Steam ID');
  if (unique.length === 0) return [];
  const deps = resolveDeps(socialDeps);
  const { store, now } = deps;

  const found = new Map<string, FriendLibrary>();
  const qit = await bestEffort('QIT library index read failed', () => store.readQitLibraries(unique), new Map());
  for (const [steamId, library] of qit) found.set(steamId, { steamId, state: 'ok', source: 'qit', games: library.games, fetchedAt: library.updatedAt });

  const others = unique.filter(id => !found.has(id));
  if (others.length) {
    const cached = await bestEffort('Public library cache read failed', () => store.readPublicLibraries(others), new Map<string, PublicLibraryRecord>());
    for (const id of others) {
      const record = cached.get(id);
      const library = record && record.expiresAt.toMillis() > now() ? fromRecord(id, record) : null;
      if (library) found.set(id, library);
    }
    // The client's own limiter spreads these calls, so asking for all of them at once is fine.
    await Promise.all(others.filter(id => !found.has(id)).map(async id => { found.set(id, await loadLive(id, deps)); }));
  }
  return unique.map(id => found.get(id) as FriendLibrary);
}
