import type { Timestamp } from 'firebase-admin/firestore';
import type { FilterSelection, ModeId, Reason, Scope } from '../roulette/types';

// Record shapes for the collections in `paths.ts`. New time fields are Firestore `Timestamp`s
// (the older `games`, `achievementProgress` and `apps` docs keep their ISO strings). A missing
// optional field means "unknown", never zero. Owning packages may tighten these as they land.

/**
 * One game in the compact library index (`users/{id}/libIndex/{libIndexChunkOf(appid)}`, map `games`, keyed by appid).
 * Each field group has one writer: library-model (n, i, p, w, r, s), app-metadata (f), achievements-data (ap, au, at).
 */
export interface LibIndexEntry {
  /** name */
  n: string;
  /** icon hash (`img_icon_url`) */
  i?: string;
  /** playtime_forever, minutes */
  p?: number;
  /** playtime_2weeks, minutes */
  w?: number;
  /** rtime_last_played, Unix seconds: 0 means never played; absent means unknown (library-model never stores 0 with p > 0) */
  r?: number;
  /** has_community_visible_stats: 1 or 0 */
  s?: number;
  /** store flag bits */
  f?: number;
  /** achievement percent unlocked */
  ap?: number;
  /** achievements unlocked */
  au?: number;
  /** achievements total */
  at?: number;
}

export interface LibIndexChunk {
  games: Record<string, LibIndexEntry>;
  updatedAt?: Timestamp;
}

export interface UserRecord {
  steamId: string;
  personaName: string;
  profileUrl: string;
  avatarFull: string;
  avatarMedium: string;
  public: boolean;
  lastSyncedAt?: string;
  /** IANA timezone, validated before storing */
  tz?: string;
  flags?: { playtimeHidden?: boolean; friendsListPublic?: boolean };
}

/** One friend (or pinned player) as last seen in `GetPlayerSummaries`. Written only by `src/lib/social/friends.ts`. */
export interface FriendSummaryRecord {
  name: string;
  /** Profile page URL */
  url: string;
  /** Full-size avatar URL */
  avatar: string;
  avatarMedium?: string;
  /** Steam `personastate`: 0 offline, 1 online, 2 busy, 3 away, 4 snooze, 5 looking to trade, 6 looking to play. Absent when Steam does not share it. */
  status?: number;
  /** Steam app id of the game being played, when it is a Steam game and visible */
  gameId?: number;
  /** Name of the game being played, when visible */
  game?: string;
}

/** `users/{id}/meta/friends`: a 15-minute snapshot of the requester's friends list. */
export interface FriendsMetaRecord {
  /** Friend ids in Steam's order. When the list is private, the pinned ids that were looked up instead. */
  ids: string[];
  /** Players Steam has no summary for are absent. */
  summaries: Record<string, FriendSummaryRecord>;
  state: 'ok' | 'private';
  fetchedAt: Timestamp;
}

/** `users/{id}/meta/pinned`: players the user added by hand, used when the friends list is private. */
export interface PinnedMetaRecord {
  ids: string[];
  updatedAt: Timestamp;
}

export type RollStatus = 'rolled' | 'accepted' | 'rerolled';

/** Written only by `src/lib/history/rolls.ts`. */
export interface RollRecord {
  appid: number;
  /** Game name at roll time, so history still reads well after the game leaves the library. */
  name?: string;
  modeId: ModeId;
  filters: FilterSelection[];
  scope: Scope;
  /** Everyone in the scope, requester first. */
  participants: string[];
  lobbyId?: string;
  at: Timestamp;
  status: RollStatus;
  acceptedAt?: Timestamp;
  rerolledAt?: Timestamp;
  /** Independent of `status`: a rerolled game can still turn out to be played. */
  playedAt?: Timestamp;
  playedSource?: 'sync' | 'manual';
  /** Minutes; null when playtime was unknown (hidden) at roll time. */
  playtimeAtRoll: number | null;
  reasons: Reason[];
}

/** Append-only; written only by `src/lib/history/events.ts`. */
export interface EventRecord {
  type: string;
  at: Timestamp;
  appid?: number;
  refId?: string;
  meta?: Record<string, unknown>;
}

export type ExclusionScope = 'session' | 'day' | '7d' | 'forever';

/** One map doc keyed by appid; written only by `src/lib/history/exclusions.ts`. */
export interface ExclusionsRecord {
  [appid: string]: { scope: ExclusionScope; until?: Timestamp; sessionId?: string; at: Timestamp };
}

/** Written only by `src/lib/history/stats.ts`. */
export interface StatsSummaryRecord {
  counters: Record<string, number>;
  streak?: { current: number; longest: number; lastDay?: string };
  updatedAt: Timestamp;
}

export interface DailyRecord {
  appid: number;
  modeId: string;
  status: string;
  rerolls: number;
  previous: number[];
  decidedAt?: Timestamp;
}

export interface ChallengeRecord {
  kind: string;
  appid: number;
  apiname?: string;
  threshold?: number;
  acceptedAt: Timestamp;
  status: string;
  completedAt?: Timestamp;
  expiresAt: Timestamp;
}

export interface AppMetaRecord {
  type?: string;
  categories?: number[];
  flags?: number;
  tagids?: number[];
  release?: number;
  art?: Record<string, string>;
  /** Steam review score bucket, 1 (overwhelmingly negative) to 9 (overwhelmingly positive) */
  review?: number;
  /** percent of reviews that are positive, 0-100 */
  reviewPercent?: number;
  reviewCount?: number;
  /** base game of a DLC, soundtrack or demo */
  parentAppid?: number;
  /** 'unknown' is the negative cache entry: Steam has no metadata for this app */
  state: 'ok' | 'unknown';
  fetchedAt: Timestamp;
}

export interface AppLiveRecord {
  /** null when the app has no player counter */
  players: number | null;
  fetchedAt: Timestamp;
  expiresAt: Timestamp;
}

export interface AppAchievementsRecord {
  /** global unlock percent by apiname */
  percents: Record<string, number>;
  fetchedAt: Timestamp;
}

/**
 * `publicLibraries/{steamId}`: a non-QIT player's library, cached for a short time. Written only by
 * `src/lib/social/libraries.ts`.
 */
export interface PublicLibraryRecord {
  state: 'ok' | 'private' | 'not_found' | 'error';
  /**
   * The games as one JSON string (see `encodeGames` in `social/libraries.ts`), empty unless `state` is `ok`. It is a
   * string, not a map, because every map key and subfield of a document gets its own index entries, and a large
   * library would go over Firestore's 40,000 index entries per document.
   */
  games: string;
  fetchedAt: Timestamp;
  expiresAt: Timestamp;
}

export interface LobbyRecord {
  hostId: string;
  expiresAt: Timestamp;
  version: number;
  status: string;
  filters: Record<string, unknown>;
  members: Record<string, Record<string, unknown>>;
  result?: Record<string, unknown>;
  rejected: number[];
  votes: Record<string, unknown>;
  vetoes: Record<string, number[]>;
}

export interface LobbyCommonChunkRecord {
  appids: number[];
}
