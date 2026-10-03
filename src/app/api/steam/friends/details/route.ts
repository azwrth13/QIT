import { getSteamId } from '@/lib/auth';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, parseSteamId, readJsonBody } from '@/lib/http/guards';
import { getFriends } from '@/lib/social/friends';
import { getSharedDetails } from '@/lib/social/dashboard';
import { getRecentDetails } from '@/lib/social/recent';
import { logServerError } from '@/lib/steam';

// One player per request. Enough burst for a visible page (14), with bounded ongoing lookups.
const limits = { user: createLimiter({ capacity: 30, refillPerSecond: 0.5 }), ip: createLimiter({ capacity: 120, refillPerSecond: 2 }) };
export async function POST(req: Request) {
  const requester = await getSteamId();
  if (!requester) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, requester, limits);
  if (denied) return denied;
  const parsed = await readJsonBody(req);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as { steamId?: unknown; kind?: unknown; includeGames?: unknown } | null;
  const player = parseSteamId(body?.steamId);
  if (!player || (body?.kind !== 'shared' && body?.kind !== 'recent') ||
      (body.includeGames !== undefined && typeof body.includeGames !== 'boolean')) {
    return errorResponse('invalid', 'Choose a player and shared games or recent activity.');
  }
  try {
    const list = await getFriends(requester);
    if (!list.friends.some(friend => friend.steamId === player)) return errorResponse('forbidden', 'Choose a Steam friend or pin this player first.');
    return jsonResponse(body.kind === 'shared' ? await getSharedDetails(requester, player, body.includeGames === true) : await getRecentDetails(player));
  } catch (error) {
    logServerError('Friend dashboard details failed', error);
    return errorResponse('unavailable', 'Could not load these games. Please try again.');
  }
}
