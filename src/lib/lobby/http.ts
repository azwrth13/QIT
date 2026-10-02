import { getSteamId } from '../auth';
import { checkSameOrigin, errorResponse, jsonResponse } from '../http/guards';
import { logServerError } from '../steam';
import { LobbyError } from './model';

export async function lobbyGuard(req: Request, mutation = true): Promise<{ steamId: string } | { response: Response }> {
  const steamId = await getSteamId();
  if (!steamId) return { response: errorResponse('unauthenticated', 'Sign in with Steam to use a lobby.') };
  const denied = mutation ? checkSameOrigin(req) : null;
  return denied ? { response: denied } : { steamId };
}

export function lobbyFailure(error: unknown): Response {
  if (error instanceof LobbyError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status,
    error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
  logServerError('Lobby request failed', error);
  return errorResponse('unavailable', 'Could not load the lobby. Please try again.');
}

export type LobbyRouteContext = { params: Promise<{ code: string }> };
