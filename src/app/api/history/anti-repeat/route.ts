import { getSteamId } from '@/lib/auth';
import { ANTI_REPEAT_OPTIONS, DEFAULT_ANTI_REPEAT_DAYS, getAntiRepeatDays, isValidAntiRepeatDays, setAntiRepeatDays } from '@/lib/history/anti-repeat';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, readJsonBody } from '@/lib/http/guards';
import { logServerError } from '@/lib/steam';

// GET  /api/history/anti-repeat      returns the user's anti-repeat window in days (default 30, options: 0, 7, 30, 90)
// POST /api/history/anti-repeat { days } updates the user's anti-repeat window

const readLimits = { user: createLimiter({ capacity: 30, refillPerSecond: 1 }), ip: createLimiter({ capacity: 120, refillPerSecond: 4 }) };
const writeLimits = { user: createLimiter({ capacity: 10, refillPerSecond: 0.2 }), ip: createLimiter({ capacity: 40, refillPerSecond: 1 }) };

export async function GET(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkRateLimit(req, steamId, readLimits);
  if (denied) return denied;

  try {
    const days = await getAntiRepeatDays(steamId);
    return jsonResponse({
      days,
      options: ANTI_REPEAT_OPTIONS,
      defaultDays: DEFAULT_ANTI_REPEAT_DAYS,
    });
  } catch (error) {
    logServerError('Anti-repeat lookup failed', error);
    return errorResponse('unavailable', 'Anti-repeat setting is unavailable right now');
  }
}

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, writeLimits);
  if (denied) return denied;

  const parsed = await readJsonBody(req, 256);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as { days?: unknown } | null;
  const days = body?.days;

  if (!isValidAntiRepeatDays(days)) {
    return errorResponse('invalid', `days must be one of: ${ANTI_REPEAT_OPTIONS.join(', ')}`);
  }

  try {
    const saved = await setAntiRepeatDays(steamId, days);
    return jsonResponse({ days: saved });
  } catch (error) {
    logServerError('Anti-repeat update failed', error);
    return errorResponse('unavailable', 'Anti-repeat setting could not be saved');
  }
}
