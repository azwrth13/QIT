import { localDate } from './time';

export interface ProgressionEvent {
  id: string;
  type: string;
  at: number;
  appid?: number;
  refId?: string;
  meta?: Record<string, unknown>;
}

export interface Progression {
  current: number;
  longest: number;
  lastDay: string | null;
  gamesDiscovered: number;
  backlogGamesStarted: number;
  challengesCompleted: number;
  rareAchievementsCompleted: number;
}

type Action = { played?: boolean; challenge?: boolean; rare?: boolean };
/** The extension point for qualifying actions. Decisions and rolls never earn a streak day. */
export const QUALIFYING_ACTIONS: Readonly<Record<string, Action>> = Object.freeze({
  played: { played: true },
  daily_played: { played: true },
  friend_night_played: { played: true },
  challenge_complete: { challenge: true },
  rare_challenge_complete: { challenge: true, rare: true },
});

const ordinal = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/** Rebuilding from immutable event identities makes replays and out-of-order delivery harmless.
 * All instants are interpreted in the current profile timezone, including after a timezone change.
 */
export function calculateProgression(events: Iterable<ProgressionEvent>, tz: string, now: number): Progression {
  const seen = new Set<string>();
  const days = new Set<string>();
  const discovered = new Set<number>();
  const started = new Set<number>();
  const challenges = new Set<string>();
  const rare = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id) || !Number.isFinite(event.at) || event.at > now) continue;
    seen.add(event.id);
    const action = Object.hasOwn(QUALIFYING_ACTIONS, event.type) ? QUALIFYING_ACTIONS[event.type] : undefined;
    if (!action) continue;
    days.add(localDate(event.at, tz));
    if (action.played && event.appid !== undefined) {
      discovered.add(event.appid);
      if (event.meta?.playtimeAtRoll === 0) started.add(event.appid);
    }
    if (action.challenge) {
      const identity = event.refId ?? event.id;
      challenges.add(identity);
      if (action.rare || event.meta?.kind === 'rare') rare.add(identity);
    }
  }
  const ordered = [...days].sort();
  let run = 0;
  let longest = 0;
  let previous = -Infinity;
  for (const day of ordered) {
    const current = ordinal(day);
    run = current === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = current;
  }
  const lastDay = ordered.at(-1) ?? null;
  const today = ordinal(localDate(now, tz));
  return {
    current: lastDay && today - ordinal(lastDay) <= 1 ? run : 0,
    longest, lastDay,
    gamesDiscovered: discovered.size,
    backlogGamesStarted: started.size,
    challengesCompleted: challenges.size,
    rareAchievementsCompleted: rare.size,
  };
}
