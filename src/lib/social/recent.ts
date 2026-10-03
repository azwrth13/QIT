import { getRecentlyPlayedGames } from '../steam/owned';
import { PRIVATE_GAMES_MESSAGE, type RecentDetails } from './dashboard-types';

/** On expansion only; the card keeps the result while it stays mounted. */
export async function getRecentDetails(id: string): Promise<RecentDetails> {
  const result = await getRecentlyPlayedGames(id, 5);
  return result.state === 'private' ? { state: 'private', message: PRIVATE_GAMES_MESSAGE } : { state: 'ok', games: result.games };
}
