import type { Timestamp } from 'firebase-admin/firestore';

// Record shapes for the collections in `paths.ts`. New time fields are Firestore `Timestamp`s
// (the older `games`, `achievementProgress` and `apps` docs keep their ISO strings). A missing
// optional field means "unknown", never zero. Owning packages may tighten these as they land.

/**
 * One game in the compact library index (`users/{id}/libIndex/{appid % 4}`, map `games`, keyed by appid).
 * Each field group has one writer: library-model (n, i, p, w, r), app-metadata (f), achievements-data (ap, au, at).
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
  /** rtime_last_played, Unix seconds (0 with p > 0 means unknown) */
  r?: number;
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

export interface FriendsMetaRecord {
  ids: string[];
  summaries: Record<string, { name: string; avatar?: string; status?: number; gameId?: number }>;
  state: 'ok' | 'private' | 'error';
  fetchedAt: Timestamp;
}

export interface PinnedMetaRecord {
  ids: string[];
  updatedAt: Timestamp;
}

export interface RollRecord {
  appid: number;
  modeId: string;
  filters: Record<string, unknown>;
  scope: string;
  participants: string[];
  lobbyId?: string;
  at: Timestamp;
  status: string;
  acceptedAt?: Timestamp;
  playedAt?: Timestamp;
  playedSource?: 'sync' | 'manual';
  playtimeAtRoll: number;
  reasons: Array<{ code: string; params?: Record<string, unknown> }>;
}

export interface EventRecord {
  type: string;
  at: Timestamp;
  appid?: number;
  refId?: string;
  meta?: Record<string, unknown>;
}

export type ExclusionScope = 'session' | 'day' | '7d' | 'forever';

export interface ExclusionsRecord {
  [appid: string]: { scope: ExclusionScope; until?: Timestamp; sessionId?: string; at: Timestamp };
}

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
  review?: number;
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

export interface PublicLibraryRecord {
  state: 'ok' | 'private' | 'not_found' | 'error';
  games: Record<string, LibIndexEntry>;
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
