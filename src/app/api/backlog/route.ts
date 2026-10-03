import { getSteamId } from '@/lib/auth';
import { getBacklogOverview } from '@/lib/backlog/service';
import { checkRateLimit, createLimiter, errorResponse, jsonResponse } from '@/lib/http/guards';
import { logServerError } from '@/lib/steam';

// GET /api/backlog
// Returns category tabs, counts, and games matching each backlog category for the signed-in user.

const limits = {
  user: createLimiter({ capacity: 30, refillPerSecond: 1 }),
  ip: createLimiter({ capacity: 120, refillPerSecond: 4 }),
};

export async function GET(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkRateLimit(req, steamId, limits);
  if (denied) return denied;

  try {
    const overview = await getBacklogOverview(steamId);
    return jsonResponse(overview);
  } catch (error) {
    logServerError('Backlog overview failed', error);
    return errorResponse('unavailable', 'Your backlog is unavailable right now');
  }
}
