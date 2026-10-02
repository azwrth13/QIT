import { errorResponse, jsonResponse, NO_STORE, readJsonBody } from '@/lib/http/guards';
import { lobbyFailure, lobbyGuard, type LobbyRouteContext } from '@/lib/lobby/http';
import { editLobby, leaveLobby, pollLobby } from '@/lib/lobby/service';
import type { FilterSelection } from '@/lib/roulette/types';
import type { LobbyMemberRecord } from '@/lib/store/types';

export const runtime = 'nodejs';

export async function GET(req: Request, context: LobbyRouteContext) {
  const guard = await lobbyGuard(req, false);
  if ('response' in guard) return guard.response;
  const raw = new URL(req.url).searchParams.get('since');
  const since = raw === null ? undefined : Number(raw);
  if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(since))) return errorResponse('invalid', 'since must be a nonnegative version.');
  try {
    const lobby = await pollLobby((await context.params).code, since);
    return lobby ? jsonResponse({ lobby }) : new Response(null, { status: 304, headers: { 'Cache-Control': NO_STORE } });
  } catch (error) { return lobbyFailure(error); }
}

export async function DELETE(req: Request, context: LobbyRouteContext) {
  const guard = await lobbyGuard(req);
  if ('response' in guard) return guard.response;
  try { return jsonResponse({ lobby: await leaveLobby((await context.params).code, guard.steamId) }); }
  catch (error) { return lobbyFailure(error); }
}

export async function PATCH(req: Request, context: LobbyRouteContext) {
  const guard = await lobbyGuard(req);
  if ('response' in guard) return guard.response;
  const parsed = await readJsonBody(req);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('invalid', 'Provide state or filters.');
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !['state', 'filters'].includes(keys[0])) return errorResponse('invalid', 'Provide either state or filters.');
  if ('state' in value && !['present', 'ready', 'away'].includes(String(value.state))) return errorResponse('invalid', 'Invalid member state.');
  if ('filters' in value && !Array.isArray(value.filters)) return errorResponse('invalid', 'filters must be a list.');
  const edit = 'state' in value ? { state: value.state as LobbyMemberRecord['state'] } : { filters: value.filters as FilterSelection[] };
  try { return jsonResponse({ lobby: await editLobby((await context.params).code, guard.steamId, edit) }); }
  catch (error) { return lobbyFailure(error); }
}
