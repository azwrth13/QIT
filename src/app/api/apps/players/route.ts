import { getSteamId } from '@/lib/auth';
import { getCurrentPlayers, liveSignalsOf, PLAYER_BATCH_LIMIT } from '@/lib/apps/live-players';
import { ownsGames } from '@/lib/library';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, parseAppId, readJsonBody } from '@/lib/http/guards';
import { logServerError } from '@/lib/steam';
import { appIdSegment } from '@/lib/store/paths';

const limits = { user: createLimiter({ capacity: 20, refillPerSecond: 0.5 }), ip: createLimiter({ capacity: 60, refillPerSecond: 2 }) };

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  const parsed = await readJsonBody(req, 2048);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as { appids?: unknown } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.appids)
    || body.appids.length > PLAYER_BATCH_LIMIT || body.appids.some(id => parseAppId(id) === null)) {
    return errorResponse('invalid', 'Provide at most 40 valid app IDs');
  }
  const appids = [...new Set(body.appids as number[])];
  try { appids.forEach(appIdSegment); } catch { return errorResponse('invalid', 'Invalid app ID'); }
  try {
    if (!(await ownsGames(steamId, appids))) return errorResponse('forbidden', 'Only owned games may be requested');
    const result = await getCurrentPlayers(appids);
    return jsonResponse({ players: Object.fromEntries(liveSignalsOf(result.players)), unresolved: result.unresolved, fetched: result.fetched });
  } catch (error) {
    logServerError('Player counts failed', error);
    return errorResponse('unavailable', 'Player counts are unavailable right now');
  }
}
