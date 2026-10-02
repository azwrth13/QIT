import type { FilterSelection } from '../roulette/types';
import type { LobbyRecord } from '../store/types';

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const MAX_MEMBERS = 8;
export const IDLE_TTL_MS = 6 * 60 * 60 * 1000;

export function parseLobbyCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase();
  return code.length === 6 && [...code].every(char => CODE_ALPHABET.includes(char)) ? code : null;
}

export class LobbyError extends Error {
  constructor(public code: string, message: string, public status: number, public retryAfter?: number) {
    super(message);
  }
}

export interface LobbyView {
  code: string;
  hostId: string;
  version: number;
  status: LobbyRecord['status'];
  expiresAt: number;
  filters: FilterSelection[];
  members: { steamId: string; name: string; avatar: string | null; state: 'present' | 'ready' | 'away'; libraryState: 'ok' | 'private' | 'not_found' | 'error'; playtimeHidden: boolean }[];
  commonCount: number;
  filteredCount: number;
  filterUnknownCount: number;
}

export function lobbyView(code: string, record: LobbyRecord): LobbyView {
  return {
    code, hostId: record.hostId, version: record.version, status: record.status,
    expiresAt: record.expiresAt.toMillis(), filters: record.filters,
    members: Object.entries(record.members)
      .sort(([a, x], [b, y]) => x.joinedAt.toMillis() - y.joinedAt.toMillis() || (a < b ? -1 : a > b ? 1 : 0))
      .map(([steamId, member]) => ({
      steamId, name: member.name, avatar: member.avatar, state: member.state, libraryState: member.libraryState, playtimeHidden: member.playtimeHidden,
    })),
    commonCount: record.commonCount, filteredCount: record.filteredCount, filterUnknownCount: record.filterUnknownCount,
  };
}
