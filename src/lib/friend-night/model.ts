import { atLeastOneNeverPlayed, everyoneUnderHours, nobodyPlayed, veteranWithNewcomers } from '../group/filters';
import type { GroupSignals } from '../roulette/types';

export const DISCOVERY = ['any', 'nobody', 'one-new', 'under-hours', 'veteran', 'everyone-played'] as const;
export type Discovery = typeof DISCOVERY[number];
export function matchesDiscovery(group: GroupSignals, discovery: Discovery, hours: number): boolean {
  switch (discovery) {
    case 'any': return true;
    case 'nobody': return nobodyPlayed(group);
    case 'one-new': return atLeastOneNeverPlayed(group);
    case 'under-hours': return everyoneUnderHours(group, hours);
    case 'veteran': return veteranWithNewcomers(group, hours);
    case 'everyone-played': return group.members.length > 0 && group.members.every(m => m.owns && m.playtimeForever !== null && m.playtimeForever > 0);
  }
}
export type LibraryState = 'loading' | 'ok' | 'private' | 'not_found' | 'error';
export interface PlayerState { steamId: string; name: string; state: LibraryState; count?: number }
