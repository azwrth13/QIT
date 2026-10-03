import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { paths } from '../store/paths';
import { getRecentlyPlayedGames, type RecentlyPlayedResult } from '../steam/owned';
import { dashboardSteamClient } from './dashboard-budget';
import { bestEffort } from './deps';
import { PRIVATE_GAMES_MESSAGE, type RecentDetails } from './dashboard-types';

export const RECENT_TTL_MS = 10 * 60 * 1000;
interface RecentRecord { result: RecentlyPlayedResult; expiresAt: Timestamp }
export interface RecentDeps {
  read(id: string): Promise<RecentRecord | null>;
  write(id: string, record: RecentRecord): Promise<void>;
  fetch(id: string): Promise<RecentlyPlayedResult>;
  now(): number;
}
const defaults: RecentDeps = {
  read: async id => (await db.doc(paths.publicRecentPlays(id)).get()).data() as RecentRecord | undefined ?? null,
  write: async (id, record) => { await db.doc(paths.publicRecentPlays(id)).set(record); },
  fetch: id => getRecentlyPlayedGames(id, 5, dashboardSteamClient), // Uses the shared Steam client and global budget guard.
  now: Date.now,
};
const inflight = new Map<string, Promise<RecentDetails>>();

/** On expansion only. Non-QIT recent activity is retained for ten minutes, below D10's thirty-minute cap. */
export function getRecentDetails(id: string, deps: RecentDeps = defaults): Promise<RecentDetails> {
  const existing = inflight.get(id);
  if (existing) return existing;
  const task = (async (): Promise<RecentDetails> => {
    const cached = await bestEffort('Recent activity cache read failed', () => deps.read(id), null);
    const valid = cached && cached.expiresAt.toMillis() > deps.now();
    const result = valid ? cached.result : await deps.fetch(id);
    if (!valid) await bestEffort('Recent activity cache write failed', () => deps.write(id, {
      result, expiresAt: Timestamp.fromMillis(deps.now() + (result.state === 'private' ? 5 * 60 * 1000 : RECENT_TTL_MS)),
    }), undefined);
    return result.state === 'private' ? { state: 'private', message: PRIVATE_GAMES_MESSAGE } : { state: 'ok', games: result.games };
  })();
  inflight.set(id, task);
  const clear = () => { if (inflight.get(id) === task) inflight.delete(id); };
  task.then(clear, clear);
  return task;
}
