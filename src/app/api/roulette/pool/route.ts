import { getSteamId } from '@/lib/auth';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, readJsonBody } from '@/lib/http/guards';
import { SpinInputError } from '@/lib/roulette/pipeline';
import { parseSpinRequest, SPIN_MAX_BODY_BYTES } from '@/lib/roulette/request';
import { previewPool } from '@/lib/roulette/service';
import { logServerError } from '@/lib/steam';

// POST /api/roulette/pool { mode?, filters?, scope?, exclude?, showNonGames?, sessionId? }
// Counts for the picker's "N games match" line: { preview, coverage, eligible, playtimeHidden }. Reads stored data
// only (no Steam calls) and writes nothing.

const limits = { user: createLimiter({ capacity: 30, refillPerSecond: 1 }), ip: createLimiter({ capacity: 120, refillPerSecond: 4 }) };

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  const body = await readJsonBody(req, SPIN_MAX_BODY_BYTES);
  if ('response' in body) return body.response;
  const parsed = parseSpinRequest(body.body, 'pool');
  if (!parsed.ok) return errorResponse('invalid', parsed.error);
  try {
    return jsonResponse(await previewPool(steamId, parsed.request));
  } catch (error) {
    if (error instanceof SpinInputError) return errorResponse('invalid', error.message);
    logServerError('Pool preview failed', error);
    return errorResponse('unavailable', 'The roulette is unavailable right now');
  }
}
