import type { RecentGame } from '../steam/owned';
import type { LibraryState } from './libraries';

export interface SharedGame {
  appid: number;
  name: string;
  friendMinutes: number | null;
}
export type SharedDetails =
  | { state: 'ok'; count: number; games?: SharedGame[] }
  | { state: Exclude<LibraryState, 'ok'>; message: string };
export type RecentDetails = { state: 'ok'; games: RecentGame[] } | { state: 'private'; message: string };
export const PRIVATE_GAMES_MESSAGE = 'Steam game details are private. QIT cannot read this player’s games, even when they sign in.';
