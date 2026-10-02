import { clientIpFromForwardedFor } from '@/lib/client-ip';
import { jsonResponse } from '@/lib/http/guards';
import { lobbyFailure, lobbyGuard, type LobbyRouteContext } from '@/lib/lobby/http';
import { joinLobby } from '@/lib/lobby/service';

export const runtime = 'nodejs';

export async function POST(req: Request, context: LobbyRouteContext) {
  const guard = await lobbyGuard(req);
  if ('response' in guard) return guard.response;
  try {
    return jsonResponse({ lobby: await joinLobby((await context.params).code, guard.steamId, clientIpFromForwardedFor(req.headers)) });
  } catch (error) { return lobbyFailure(error); }
}
