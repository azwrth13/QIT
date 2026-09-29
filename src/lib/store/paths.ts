import { isSteamId } from '../steam';

// The only place that spells Firestore collection names. Everything else builds paths through
// these helpers (`db.doc(paths.rolls(id))`), which also validate every id so a caller can never
// smuggle a `/` or `..` into a path.

export const COLLECTIONS = {
  users: 'users',
  games: 'games',
  libIndex: 'libIndex',
  achievementProgress: 'achievementProgress',
  meta: 'meta',
  rolls: 'rolls',
  events: 'events',
  prefs: 'prefs',
  stats: 'stats',
  daily: 'daily',
  challenges: 'challenges',
  apps: 'apps',
  appMeta: 'appMeta',
  appLive: 'appLive',
  appAchievements: 'appAchievements',
  publicLibraries: 'publicLibraries',
  lobbies: 'lobbies',
  common: 'common',
} as const;

const C = COLLECTIONS;
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
const APP_ID = /^[1-9]\d{0,9}$/;
const DATE_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function steamIdSegment(steamId: string): string {
  if (!isSteamId(steamId)) throw new Error('Invalid Steam ID');
  return steamId;
}

export function appIdSegment(appid: number | string): string {
  const id = String(appid);
  if (!APP_ID.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Invalid app ID');
  return id;
}

export function chunkSegment(chunk: number): string {
  if (!Number.isSafeInteger(chunk) || chunk < 0) throw new Error('Invalid chunk');
  return String(chunk);
}

export function dateSegment(date: string): string {
  if (!DATE_KEY.test(date)) throw new Error('Invalid date key');
  return date;
}

/** Ids we generate ourselves (roll, event, challenge ids, lobby codes): 1 to 128 of `[A-Za-z0-9_-]`. */
export function docIdSegment(id: string): string {
  if (!DOC_ID.test(id)) throw new Error('Invalid document ID');
  return id;
}

const user = (steamId: string) => `${C.users}/${steamIdSegment(steamId)}`;

export const paths = {
  users: () => C.users,
  user,
  userGames: (steamId: string) => `${user(steamId)}/${C.games}`,
  userGame: (steamId: string, appid: number) => `${user(steamId)}/${C.games}/${appIdSegment(appid)}`,
  libIndex: (steamId: string) => `${user(steamId)}/${C.libIndex}`,
  libIndexChunk: (steamId: string, chunk: number) => `${user(steamId)}/${C.libIndex}/${chunkSegment(chunk)}`,
  achievementProgress: (steamId: string) => `${user(steamId)}/${C.achievementProgress}`,
  achievementProgressDoc: (steamId: string, appid: number) =>
    `${user(steamId)}/${C.achievementProgress}/${appIdSegment(appid)}`,
  friendsMeta: (steamId: string) => `${user(steamId)}/${C.meta}/friends`,
  pinnedMeta: (steamId: string) => `${user(steamId)}/${C.meta}/pinned`,
  rolls: (steamId: string) => `${user(steamId)}/${C.rolls}`,
  roll: (steamId: string, rollId: string) => `${user(steamId)}/${C.rolls}/${docIdSegment(rollId)}`,
  events: (steamId: string) => `${user(steamId)}/${C.events}`,
  event: (steamId: string, eventId: string) => `${user(steamId)}/${C.events}/${docIdSegment(eventId)}`,
  exclusions: (steamId: string) => `${user(steamId)}/${C.prefs}/exclusions`,
  statsSummary: (steamId: string) => `${user(steamId)}/${C.stats}/summary`,
  dailies: (steamId: string) => `${user(steamId)}/${C.daily}`,
  daily: (steamId: string, date: string) => `${user(steamId)}/${C.daily}/${dateSegment(date)}`,
  challenges: (steamId: string) => `${user(steamId)}/${C.challenges}`,
  challenge: (steamId: string, id: string) => `${user(steamId)}/${C.challenges}/${docIdSegment(id)}`,
  /** Genre cache owned by `genre-cache.ts`, overwritten with plain `set`: never store anything else here. */
  app: (appid: number) => `${C.apps}/${appIdSegment(appid)}`,
  appMeta: (appid: number) => `${C.appMeta}/${appIdSegment(appid)}`,
  appLive: (appid: number) => `${C.appLive}/${appIdSegment(appid)}`,
  appAchievements: (appid: number) => `${C.appAchievements}/${appIdSegment(appid)}`,
  publicLibrary: (steamId: string) => `${C.publicLibraries}/${steamIdSegment(steamId)}`,
  lobbies: () => C.lobbies,
  lobby: (code: string) => `${C.lobbies}/${docIdSegment(code)}`,
  lobbyCommonChunk: (code: string, chunk: number) => `${C.lobbies}/${docIdSegment(code)}/${C.common}/${chunkSegment(chunk)}`,
};
