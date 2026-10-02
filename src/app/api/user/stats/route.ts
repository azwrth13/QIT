import { getSteamId } from '@/lib/auth';
import { readStats } from '@/lib/history/stats';
import { checkRateLimit, createLimiter, errorResponse, jsonResponse } from '@/lib/http/guards';
import { logServerError } from '@/lib/steam';

const limits = { user: createLimiter({ capacity: 20, refillPerSecond: 0.5 }), ip: createLimiter({ capacity: 60, refillPerSecond: 2 }) };

export async function GET(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  try {
    return jsonResponse(await readStats(steamId));
  } catch (error) {
    logServerError('Stats read failed', error);
    return errorResponse('unavailable', 'Progress is unavailable right now');
  }
}
