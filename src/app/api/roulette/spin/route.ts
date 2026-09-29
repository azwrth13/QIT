import { getSteamId } from '@/lib/auth';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, readJsonBody } from '@/lib/http/guards';
import { SpinInputError } from '@/lib/roulette/pipeline';
import { parseSpinRequest, SPIN_MAX_BODY_BYTES } from '@/lib/roulette/request';
import { SOURCED_FAMILIES, spin } from '@/lib/roulette/service';
import { logServerError } from '@/lib/steam';

// POST /api/roulette/spin { mode, filters?, scope?, exclude?, showNonGames?, sessionId?, seed? }
// Draws one game for the signed-in user and records the roll. Returns { card, poolSize, coverage, seed, eligible,
// preview, playtimeHidden }; `card` is null when nothing matches.

const limits = { user: createLimiter({ capacity: 10, refillPerSecond: 0.2 }), ip: createLimiter({ capacity: 40, refillPerSecond: 1 }) };

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  const body = await readJsonBody(req, SPIN_MAX_BODY_BYTES);
  if ('response' in body) return body.response;
  const parsed = parseSpinRequest(body.body, 'spin', SOURCED_FAMILIES);
  if (!parsed.ok) return errorResponse('invalid', parsed.error);
  try {
    return jsonResponse(await spin(steamId, parsed.request));
  } catch (error) {
    if (error instanceof SpinInputError) return errorResponse('invalid', error.message);
    logServerError('Spin failed', error);
    return errorResponse('unavailable', 'The roulette is unavailable right now');
  }
}
