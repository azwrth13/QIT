import { intersect } from '../group/libraries';
import { readLibIndex } from '../store/lib-index';
import { dashboardSteamClient } from './dashboard-budget';
import { getSteamLibrary } from './libraries';
import { PRIVATE_GAMES_MESSAGE, type SharedDetails } from './dashboard-types';

/** Called for one visible card, or an explicit shared-games action; never for the complete friend list. */
export async function getSharedDetails(requester: string, player: string, includeGames: boolean): Promise<SharedDetails> {
  const friend = await getSteamLibrary(player, { client: dashboardSteamClient });
  if (friend.state !== 'ok') return {
    state: friend.state,
    message: friend.state === 'private' ? PRIVATE_GAMES_MESSAGE : friend.state === 'not_found'
      ? 'Steam profile not found.' : 'Steam games are unavailable. Please try again.',
  };
  const own = await readLibIndex(requester);
  if (!own.built) return { state: 'error', message: 'Sync your library on the Library page to count shared games.' };
  const shared = intersect([{ steamId: requester, games: own.entries }, friend]);
  return {
    state: 'ok', count: shared.length,
    ...(includeGames ? { games: shared.map(game => ({ appid: game.appid, name: game.name, friendMinutes: game.playtimeByPlayer[player] })) } : {}),
  };
}
