import { FILTER_IDS, type Filter, type FilterId } from '../types';
import multiplayer from './multiplayer';
import coOp from './co-op';
import singlePlayer from './single-player';
import achievements from './achievements';
import neverPlayed from './never-played';
import playtime from './playtime';
import recentlyPlayed from './recently-played';
import notRecentlyPlayed from './not-recently-played';
import playerActivity from './player-activity';
import sharedWithFriends from './shared-with-friends';
import excludeRolled from './exclude-rolled';

// One entry per id; the mapped type makes a missing id a compile error.
const FILTERS: { [K in FilterId]: Filter } = {
  'multiplayer': multiplayer,
  'co-op': coOp,
  'single-player': singlePlayer,
  'achievements': achievements,
  'never-played': neverPlayed,
  'playtime': playtime,
  'recently-played': recentlyPlayed,
  'not-recently-played': notRecentlyPlayed,
  'player-activity': playerActivity,
  'shared-with-friends': sharedWithFriends,
  'exclude-rolled': excludeRolled,
};

export function isFilterId(value: unknown): value is FilterId {
  return typeof value === 'string' && (FILTER_IDS as readonly string[]).includes(value);
}

export function getFilter(id: FilterId): Filter {
  return FILTERS[id];
}

/** Every registered filter, stubs included, in FILTER_IDS order. */
export function listFilters(): Filter[] {
  return FILTER_IDS.map(id => FILTERS[id]);
}
