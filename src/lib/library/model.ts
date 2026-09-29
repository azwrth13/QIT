import { lastPlayedAt, type Game } from '../games';
import type { OwnedGame } from '../steam/owned';
import type { LibIndexPatch } from '../store/lib-index';
import type { LibIndexEntry } from '../store/types';

// Pure library-model logic: Steam game -> Game -> library index entry / per-game document and back,
// the sync diff and playtime-hidden detection. No Firestore, no fetch.

/** The index entry fields this package owns. app-metadata (`f`) and achievements-data (`ap`, `au`, `at`) own the rest. */
export const LIBRARY_INDEX_FIELDS = ['n', 'i', 'p', 'w', 'r', 's'] as const;
type LibraryIndexField = typeof LIBRARY_INDEX_FIELDS[number];
export type LibraryIndexFields = Pick<LibIndexEntry, LibraryIndexField>;

/**
 * `users/{steamId}/games/{appid}`, kept (dual-written) next to the index until a later cleanup. `syncLibrary` is its
 * only writer and overwrites the whole document with plain `set`, so nothing else may store data here.
 */
export interface GameDoc {
  appid: number;
  name: string;
  img_icon_url: string;
  playtime_forever: number;
  playtime_2weeks: number;
  rtime_last_played: number | null;
  has_community_visible_stats: boolean;
}

const isAppId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const minutes = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

export function fromOwnedGame(game: OwnedGame): Game {
  return {
    appid: game.appid,
    name: game.name,
    img_icon_url: game.img_icon_url,
    playtime_forever: game.playtime_forever,
    playtime_2weeks: game.playtime_2weeks,
    rtime_last_played: lastPlayedAt(game.rtime_last_played, game.playtime_forever),
    has_community_visible_stats: game.has_community_visible_stats,
  };
}

export function toGameDoc(game: Game): GameDoc {
  const playtime = minutes(game.playtime_forever);
  return {
    appid: game.appid,
    name: game.name,
    img_icon_url: game.img_icon_url || '',
    playtime_forever: playtime,
    playtime_2weeks: minutes(game.playtime_2weeks),
    rtime_last_played: lastPlayedAt(game.rtime_last_played, playtime),
    has_community_visible_stats: game.has_community_visible_stats === true,
  };
}

/** Reads a per-game document, including ones written before the extra fields existed (their recency is unknown). */
export function fromGameDoc(data: Record<string, unknown> | undefined): Game | null {
  if (!data || !isAppId(data.appid) || typeof data.name !== 'string') return null;
  const playtime = minutes(data.playtime_forever);
  const game: Game = {
    appid: data.appid,
    name: data.name,
    img_icon_url: typeof data.img_icon_url === 'string' ? data.img_icon_url : '',
    playtime_forever: playtime,
    rtime_last_played: lastPlayedAt(data.rtime_last_played, playtime),
  };
  if (typeof data.playtime_2weeks === 'number') game.playtime_2weeks = minutes(data.playtime_2weeks);
  if (typeof data.has_community_visible_stats === 'boolean') game.has_community_visible_stats = data.has_community_visible_stats;
  return game;
}

/** This package's index fields for a game. `r` is left out when unknown; a stored 0 always means never played. */
export function toIndexFields(game: Game): LibraryIndexFields {
  const doc = toGameDoc(game);
  const fields: LibraryIndexFields = {
    n: doc.name, i: doc.img_icon_url, p: doc.playtime_forever, w: doc.playtime_2weeks,
    s: doc.has_community_visible_stats ? 1 : 0,
  };
  if (doc.rtime_last_played !== null) fields.r = doc.rtime_last_played;
  return fields;
}

export function fromIndexEntry(appid: number, entry: LibIndexEntry): Game {
  const playtime = minutes(entry.p);
  const game: Game = {
    appid,
    name: entry.n,
    img_icon_url: entry.i ?? '',
    playtime_forever: playtime,
    rtime_last_played: lastPlayedAt(entry.r, playtime),
    has_community_visible_stats: entry.s === 1,
  };
  if (entry.w !== undefined) game.playtime_2weeks = minutes(entry.w);
  return game;
}

/**
 * The index patch that brings `stored` up to date with `game`, or null when this package's fields already match.
 * Every owned field is sent (`null` clears one that became unknown); other packages' fields are never touched.
 */
export function indexPatchFor(game: Game, stored: LibIndexEntry | undefined): LibIndexPatch | null {
  const next = toIndexFields(game);
  if (stored && LIBRARY_INDEX_FIELDS.every(field => stored[field] === next[field])) return null;
  return { ...next, r: next.r ?? null };
}

export interface SyncPlan {
  /** Games whose per-game document and index entry need writing. */
  changed: Game[];
  patches: Map<number, LibIndexPatch>;
  /** appids no longer owned: their per-game documents and index entries are deleted. */
  removed: number[];
}

/**
 * Diffs Steam's library against what is stored. `previous` holds the index entries, or, before the index was ever
 * built, the appids of legacy per-game documents mapped to `undefined` so that every game gets written once.
 */
export function planSync(games: Game[], previous: ReadonlyMap<number, LibIndexEntry | undefined>): SyncPlan {
  const plan: SyncPlan = { changed: [], patches: new Map(), removed: [] };
  const incoming = new Set<number>();
  for (const game of games) {
    if (!isAppId(game.appid) || incoming.has(game.appid)) continue;
    incoming.add(game.appid);
    const patch = indexPatchFor(game, previous.get(game.appid));
    if (!patch) continue;
    plan.changed.push(game);
    plan.patches.set(game.appid, patch);
  }
  for (const appid of previous.keys()) if (!incoming.has(appid)) plan.removed.push(appid);
  return plan;
}

/** Fewest games for which an all-zero library counts as hidden playtime rather than a library nobody has played yet. */
export const PLAYTIME_HIDDEN_MIN_GAMES = 5;

/**
 * Steam can hide a user's total playtime while Game details stay public; GetOwnedGames then reports 0 minutes
 * everywhere. A library with no playtime at all is treated as hidden when it is big enough that "never played
 * anything" is implausible, or when Steam still reports a last-played time for a game with 0 minutes.
 */
export function detectPlaytimeHidden(games: Game[]): boolean {
  if (!games.length) return false;
  if (games.some(game => minutes(game.playtime_forever) > 0 || minutes(game.playtime_2weeks) > 0)) return false;
  return games.length >= PLAYTIME_HIDDEN_MIN_GAMES || games.some(game => (game.rtime_last_played ?? 0) > 0);
}
