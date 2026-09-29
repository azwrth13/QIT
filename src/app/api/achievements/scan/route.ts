import { getSteamId } from '@/lib/auth';
import { InvalidScanCursorError, scanAchievements, SCAN_BATCH_SIZE } from '@/lib/achievements/scan';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, readJsonBody } from '@/lib/http/guards';
import { logServerError } from '@/lib/steam';

// POST /api/achievements/scan { cursor?: string | null, limit?: 1..15 }
// One batch of the signed-in user's incremental achievement scan. Call again with the returned cursor while
// `state` is `running` (after `retryAfter` seconds when it is `rate_limited`); `progress` drives the progress bar.

const limits = { user: createLimiter({ capacity: 20, refillPerSecond: 0.5 }), ip: createLimiter({ capacity: 60, refillPerSecond: 2 }) };
const PRIVATE_MESSAGE = 'Steam is not sharing your achievements. Set Game details to Public in your Steam privacy settings, then scan again.';

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  const parsed = await readJsonBody(req, 1024);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as { cursor?: unknown; limit?: unknown } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('invalid', 'Invalid request body');
  const cursor = body.cursor ?? null;
  if (cursor !== null && typeof cursor !== 'string') return errorResponse('invalid', 'Invalid cursor');
  const limit = body.limit ?? SCAN_BATCH_SIZE;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > SCAN_BATCH_SIZE) {
    return errorResponse('invalid', `limit must be 1 to ${SCAN_BATCH_SIZE}`);
  }
  try {
    const result = await scanAchievements(steamId, { cursor, limit });
    return jsonResponse({ ...result, message: result.state === 'private' ? PRIVATE_MESSAGE : null });
  } catch (error) {
    if (error instanceof InvalidScanCursorError) return errorResponse('invalid', 'Invalid cursor');
    logServerError('Achievement scan failed', error);
    return errorResponse('unavailable', 'Achievement scan is unavailable right now');
  }
}
