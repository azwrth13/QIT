import { describe, expect, it } from 'vitest';
import { deriveProfileStats } from '../src/lib/profile/stats';
import type { LibIndexEntry } from '../src/lib/store/types';

const library = (entries: Array<[number, LibIndexEntry]> = [], built = true, playtimeHidden = false) => ({ entries: new Map(entries), built, playtimeHidden });

describe('profile statistics derivation', () => {
  it('shows zero activity and a known empty library for an empty synced profile', () => {
    expect(deriveProfileStats(library(), {})).toEqual({
      totalGames: 0, neverPlayed: 0, unknownPlaytime: 0, gamesDiscovered: 0, backlogGamesStarted: 0,
      dailiesAccepted: 0, friendNightsCompleted: 0, challengesCompleted: 0, rareAchievementsCompleted: 0,
      recommendedThenPlayed: 0, mostUsedMode: null,
    });
  });
  it('distinguishes an index not built yet from an empty library', () => {
    expect(deriveProfileStats(library([], false), {})).toMatchObject({ totalGames: null, neverPlayed: null });
  });
  it('counts only zero playtime as never played and keeps incomplete or hidden totals unknown', () => {
    const entries: Array<[number, LibIndexEntry]> = [[10, { n: 'Untouched', p: 0 }], [20, { n: 'Started', p: 3 }]];
    expect(deriveProfileStats(library(entries), {})).toMatchObject({ totalGames: 2, neverPlayed: 1, unknownPlaytime: 0 });
    expect(deriveProfileStats(library([...entries, [30, { n: 'Unknown' }]]), {})).toMatchObject({ totalGames: 3, neverPlayed: null, unknownPlaytime: 1 });
    expect(deriveProfileStats(library(entries, true, true), {})).toMatchObject({ totalGames: 2, neverPlayed: null, unknownPlaytime: 2 });
  });
  it('uses distinct-game progression instead of repeated played events, and reads existing event counters', () => {
    const result = deriveProfileStats(library(), {
      counters: { played: 9, daily_accept: 4, friend_night_played: 2, challenge_complete: 8, 'roll:modeId:dust-collector': 5, 'roll:modeId:pure-random': 3 },
      progression: { gamesDiscovered: 3, backlogGamesStarted: 1, challengesCompleted: 6, rareAchievementsCompleted: 2 },
    });
    expect(result).toMatchObject({ gamesDiscovered: 3, recommendedThenPlayed: 3, backlogGamesStarted: 1,
      dailiesAccepted: 4, friendNightsCompleted: 2, challengesCompleted: 6, rareAchievementsCompleted: 2,
      mostUsedMode: { id: 'dust-collector', label: 'Dust Collector', selections: 5 } });
  });
  it('handles missing counters, invalid numbers, unknown modes, and mode ties deterministically', () => {
    expect(deriveProfileStats(library(), { counters: { daily_accept: NaN, friend_night_played: -1,
      'roll:modeId:future-mode': 99, 'roll:modeId:pure-random': 2, 'roll:modeId:dust-collector': 2 } })).toMatchObject({
      dailiesAccepted: 0, friendNightsCompleted: 0, challengesCompleted: 0,
      mostUsedMode: { id: 'pure-random', selections: 2 },
    });
  });
});
