import { getBaseUrl } from '@/lib/base-url';
import { jsonResponse } from '@/lib/http/guards';
import { lobbyFailure, lobbyGuard } from '@/lib/lobby/http';
import { createLobby } from '@/lib/lobby/service';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const guard = await lobbyGuard(req);
  if ('response' in guard) return guard.response;
  try {
    const lobby = await createLobby(guard.steamId);
    return jsonResponse({ lobby, url: `${getBaseUrl(req)}/lobby/${lobby.code}` }, 201);
  } catch (error) { return lobbyFailure(error); }
}
