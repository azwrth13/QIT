import { getSteamId } from '@/lib/auth';
import { checkRateLimit, createLimiter, errorResponse, jsonResponse } from '@/lib/http/guards';
import { modesCatalog } from '@/lib/roulette/service';

// GET /api/roulette/modes -> { modes, filters, scopes }: the implemented modes and filters the picker may offer, and
// the scopes the pipeline can resolve. Stubs are never listed.

const limits = { user: createLimiter({ capacity: 30, refillPerSecond: 1 }), ip: createLimiter({ capacity: 120, refillPerSecond: 4 }) };

export async function GET(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  return jsonResponse(modesCatalog());
}
