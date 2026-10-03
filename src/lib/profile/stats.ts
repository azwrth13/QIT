import type { Progression } from '../history/progression';
import { getMode } from '../roulette/modes';
import { MODE_IDS, type ModeId } from '../roulette/types';
import type { LibIndexEntry } from '../store/types';

export interface ProfileStats {
  totalGames: number | null;
  neverPlayed: number | null;
  unknownPlaytime: number;
  gamesDiscovered: number;
  dailiesAccepted: number;
  friendNightsCompleted: number;
  challengesCompleted: number;
  rareAchievementsCompleted: number;
  recommendedThenPlayed: number;
  mostUsedMode: { id: ModeId; label: string; selections: number } | null;
}

const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** A read-only projection. Missing activity counters are zero; missing library/playtime signals remain unknown. */
export function deriveProfileStats(
  library: { entries: ReadonlyMap<number, LibIndexEntry>; built: boolean; playtimeHidden: boolean },
  summary: { counters?: Record<string, number>; progression?: Partial<Progression> },
): ProfileStats {
  const counters = summary.counters ?? {};
  const progression = summary.progression ?? {};
  let neverPlayed = 0;
  let unknownPlaytime = 0;
  for (const game of library.entries.values()) {
    if (library.playtimeHidden || typeof game.p !== 'number' || !Number.isFinite(game.p) || game.p < 0) unknownPlaytime++;
    else if (game.p === 0) neverPlayed++;
  }
  let mostUsedMode: ProfileStats['mostUsedMode'] = null;
  // Ties follow the registry order, keeping the result stable across reads.
  for (const id of MODE_IDS) {
    const selections = count(counters[`roll:modeId:${id}`]);
    if (selections > (mostUsedMode?.selections ?? 0)) mostUsedMode = { id, label: getMode(id).label, selections };
  }
  return {
    totalGames: library.built ? library.entries.size : null,
    neverPlayed: library.built && !library.playtimeHidden && unknownPlaytime === 0 ? neverPlayed : null,
    unknownPlaytime,
    gamesDiscovered: count(progression.backlogGamesStarted),
    dailiesAccepted: count(counters.daily_accept),
    friendNightsCompleted: count(counters.friend_night_played),
    challengesCompleted: count(progression.challengesCompleted),
    rareAchievementsCompleted: count(progression.rareAchievementsCompleted),
    recommendedThenPlayed: count(progression.gamesDiscovered),
    mostUsedMode,
  };
}
