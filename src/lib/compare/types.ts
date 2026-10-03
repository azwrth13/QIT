import type { GroupGame } from '../group/libraries';

export interface ComparePlayerProfile {
  steamId: string;
  personaName: string;
  avatarUrl: string | null;
  profileUrl: string;
}

export interface CompareResult {
  target: ComparePlayerProfile;
  user: {
    steamId: string;
    personaName?: string;
    avatarUrl?: string | null;
  };
  sharedCount: number;
  both: GroupGame[];
  onlyMe: GroupGame[];
  onlyThem: GroupGame[];
  neitherRecentlyPlayed: GroupGame[];
  oneNeverPlayed: GroupGame[];
  playtimeHidden: {
    me: boolean;
    them: boolean;
  };
  /** Aliases for symmetry and backwards compatibility */
  onlyA: GroupGame[];
  onlyB: GroupGame[];
}

export interface CompareOptions {
  now?: number;
  notRecentlyPlayedDays?: number;
}

export class CompareError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = 'CompareError';
  }
}
