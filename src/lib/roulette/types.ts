// Shared roulette contracts. Pure types and id lists only: nothing here (or in any roulette engine)
// imports Firestore or fetch. Convention throughout: a missing signal family means "not loaded",
// and a `null` field means "unknown" - never read unknown as zero.

export const MODE_IDS = [
  'pure-random',
  'dust-collector',
  'something-different',
  'comfort-pick',
  'achievement-hunter',
  'alive-and-kicking',
  'everyone-owns-it',
  'finish-something',
  'rediscovery',
] as const;
export type ModeId = typeof MODE_IDS[number];

// Session filters (feature 18). "Installed" is deliberately absent: Steam exposes no installed state.
export const FILTER_IDS = [
  'multiplayer',
  'co-op',
  'single-player',
  'achievements',
  'never-played',
  'playtime',
  'recently-played',
  'not-recently-played',
  'player-activity',
  'shared-with-friends',
  'exclude-rolled',
] as const;
export type FilterId = typeof FILTER_IDS[number];

export type SignalFamily = 'library' | 'store' | 'achievements' | 'live' | 'history' | 'group';

export interface LibrarySignals {
  name: string;
  iconHash: string | null;
  /** Minutes. */
  playtimeForever: number;
  /** Minutes in the last two weeks. */
  playtime2Weeks: number | null;
  /** Unix seconds. Steam reports 0 for very old sessions, which must be stored as null when playtime > 0. */
  lastPlayedAt: number | null;
}

export type StoreFlag = 'multiplayer' | 'coop' | 'singlePlayer' | 'pvp' | 'mmo' | 'achievements';

export interface StoreSignals {
  /** Steam store item type, for example 'game', 'dlc', 'software'. */
  type: string | null;
  flags: Record<StoreFlag, boolean | null>;
  /** Unix seconds. */
  releasedAt: number | null;
  tagIds: number[];
  headerArt: string | null;
}

export interface AchievementSignals {
  total: number;
  unlocked: number;
  /** 0-100. */
  percent: number;
  /** Locked achievements under each rare tier (keys are thresholds in percent), null until rarity is joined. */
  lockedRare: Record<number, number> | null;
  /** Unix seconds. */
  lastUnlockAt: number | null;
}

export type ActivityBand = 'high' | 'mid' | 'low';

export interface LiveSignals {
  /** Current players; null when the app has no player counter. */
  players: number | null;
  band: ActivityBand | null;
}

export type ExclusionScope = 'session' | 'day' | '7d' | 'forever';

export interface HistorySignals {
  timesRolled: number;
  /** Unix seconds. */
  lastRolledAt: number | null;
  excluded: ExclusionScope | null;
  playedAfterRoll: boolean;
}

export interface GroupMemberSignals {
  steamId: string;
  owns: boolean;
  /** Minutes; null when that player's playtime is hidden or unknown. */
  playtimeForever: number | null;
}

export interface GroupSignals {
  /** Every player in the scope, including the requester. */
  members: GroupMemberSignals[];
}

export interface Signals {
  library: LibrarySignals;
  store?: StoreSignals;
  /** null once loaded means the game has no achievement data (no stats, or not scanned yet). */
  achievements?: AchievementSignals | null;
  live?: LiveSignals;
  history?: HistorySignals;
  group?: GroupSignals;
}

export interface Candidate {
  appid: number;
  signals: Signals;
}

/** Structured reason parameters by code; `reasons.ts` is the only place that turns them into text. */
export interface ReasonParams {
  random_pick: Record<string, never>;
  never_launched: Record<string, never>;
  barely_played: { minutes: number };
  idle: { months: number };
  outside_rotation: Record<string, never>;
  comfort: { hours: number };
  rediscovery: { hours: number; months: number };
  ach_remaining: { remaining: number; total: number };
  ach_near_complete: { percent: number; remaining: number };
  rare_remaining: { count: number; threshold: number };
  active_now: { players: number; band: ActivityBand | null };
  friends_all_own: { count: number };
  friends_never_played: { count: number };
  not_rolled_recently: Record<string, never>;
}
export type ReasonCode = keyof ReasonParams;
export type Reason = { [C in ReasonCode]: { code: C; params: ReasonParams[C] } }[ReasonCode];

export interface Thresholds {
  neverPlayedMinutes: number;
  barelyPlayedMinutes: number;
  notRecentlyPlayedDays: number;
  recentRotationDays: number;
  longIdleDays: number;
  rediscoveryMinMinutes: number;
  rediscoveryIdleDays: number;
  comfortMinMinutes: number;
  abandonedMinMinutes: number;
  abandonedMaxMinutes: number;
  abandonedIdleDays: number;
  closeToCompletePercent: number;
  finishSomethingPreferPercent: number;
  manyRemainingLocked: number;
  finishSomethingFewRemaining: number;
  rareTiersPercent: readonly number[];
  activeMinPlayers: number;
  activityHighPercentile: number;
  activityLowPercentile: number;
  antiRepeatDays: number;
  antiRepeatDayOptions: readonly number[];
  playedDeltaMinutes: number;
  samplerGamma: number;
}

export interface ScoreContext {
  /** Hidden totals are unknown even when Steam supplies zeros; suppress playtime and recency bonuses. */
  playtimeHidden?: boolean;
  /** Unix seconds. */
  now: number;
  thresholds: Thresholds;
  scope: Scope;
}

export interface Score {
  eligible: boolean;
  weight: number;
  /** Highest priority first. */
  reasons: Reason[];
}

export interface Mode {
  id: ModeId;
  label: string;
  description: string;
  /** Signal families the pipeline must load before scoring. */
  requires: SignalFamily[];
  /** Reason codes this mode emits, in display priority. */
  emits: ReasonCode[];
  /** Scope kinds this mode works in; everyone-owns-it needs a group. */
  scopes: ScopeKind[];
  /** True until the owning package replaces the stub. Stubs must not be offered to users. */
  stub: boolean;
  score(candidate: Candidate, ctx: ScoreContext): Score;
}

/** 'unknown' lets the pipeline decide policy and report coverage instead of silently excluding. */
export type FilterVerdict = 'pass' | 'fail' | 'unknown';

export interface FilterContext {
  /** Unix seconds. */
  now: number;
  thresholds: Thresholds;
  scope: Scope;
  /**
   * Every player in the scope, readable or not (`ScopeResult.members` plus `unavailable`). Omitted
   * means only the players in `signals.group` are known.
   */
  members?: string[];
}

export interface Filter<P = unknown> {
  id: FilterId;
  label: string;
  description: string;
  requires: SignalFamily[];
  stub: boolean;
  /** Validates request params; null means invalid. */
  parse(raw: unknown): P | null;
  test(candidate: Candidate, params: P, ctx: FilterContext): FilterVerdict;
}

export interface FilterSelection {
  id: FilterId;
  params?: unknown;
}

export const SCOPE_KINDS = ['library', 'friends', 'pair', 'lobby', 'appids'] as const;

export type Scope =
  | { kind: 'library' }
  | { kind: 'friends'; with: string[] }
  | { kind: 'pair'; with: string }
  | { kind: 'lobby'; code: string }
  | { kind: 'appids'; appids: number[] };
export type ScopeKind = typeof SCOPE_KINDS[number];

export type MemberLibraryState = 'ok' | 'private' | 'not_found' | 'error';

export interface ScopeResult {
  candidates: Candidate[];
  /** Players whose libraries formed the pool, requester first. */
  members: string[];
  /** Players dropped from the pool, for example because their game details are private. */
  unavailable: { steamId: string; state: Exclude<MemberLibraryState, 'ok'> }[];
}

export interface ScopeResolver<K extends ScopeKind = ScopeKind> {
  kind: K;
  resolve(scope: Extract<Scope, { kind: K }>, ctx: { steamId: string; now: number; fetch?: boolean }): Promise<ScopeResult>;
}

export interface SpinRequest {
  mode: ModeId;
  filters: FilterSelection[];
  scope: Scope;
  /** Appids to leave out of this spin only, for example earlier results of the same session. */
  exclude?: number[];
  /** Deterministic draws (Daily, lobby); omitted means random. */
  seed?: string;
}

export interface PlayerRef {
  steamId: string;
  name: string;
  avatar: string | null;
}

export interface Card {
  appid: number;
  name: string;
  modeId: ModeId;
  rollId: string | null;
  art: { header: string | null; icon: string | null };
  /** Top reasons, highest priority first (the card shows three). */
  reasons: Reason[];
  playtimeForever: number;
  lastPlayedAt: number | null;
  achievements: { unlocked: number; total: number; percent: number } | null;
  live: LiveSignals | null;
  friends: { owners: PlayerRef[]; playedBy: PlayerRef[]; neverPlayedBy: PlayerRef[] } | null;
  previousSelections: number;
  storeUrl: string;
  launchUrl: string;
}

export interface SpinResponse {
  card: Card | null;
  poolSize: number;
  /** Share of the pool (0-1) that had each required signal family loaded. */
  coverage: Partial<Record<SignalFamily, number>>;
}
