import { getSteamId } from '@/lib/auth';
import { spinBacklog } from '@/lib/backlog/service';
import { isBacklogCategory } from '@/lib/backlog/types';
import {
  checkRateLimit,
  checkSameOrigin,
  createLimiter,
  errorResponse,
  jsonResponse,
  readJsonBody,
} from '@/lib/http/guards';
import { logServerError } from '@/lib/steam';

// POST /api/backlog/spin { category, exclude?, sessionId?, seed? }
// Spins within a backlog category for the signed-in user and records the roll.

const limits = {
  user: createLimiter({ capacity: 20, refillPerSecond: 0.5 }),
  ip: createLimiter({ capacity: 60, refillPerSecond: 2 }),
};

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isAppId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;

  const parsed = await readJsonBody(req, 4096);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('invalid', 'Invalid spin request');
  }

  if (!isBacklogCategory(body.category)) {
    return errorResponse('invalid', 'Invalid backlog category');
  }

  let exclude: number[] | undefined;
  if (body.exclude !== undefined) {
    if (!Array.isArray(body.exclude) || body.exclude.length > 500 || !body.exclude.every(isAppId)) {
      return errorResponse('invalid', 'Invalid exclude parameter');
    }
    exclude = [...new Set(body.exclude)];
  }

  let sessionId: string | undefined;
  if (body.sessionId !== undefined) {
    if (typeof body.sessionId !== 'string' || !SESSION_ID.test(body.sessionId)) {
      return errorResponse('invalid', 'Invalid sessionId');
    }
    sessionId = body.sessionId;
  }

  let seed: string | undefined;
  if (body.seed !== undefined) {
    if (typeof body.seed !== 'string' || !body.seed.length || body.seed.length > 128) {
      return errorResponse('invalid', 'Invalid seed');
    }
    seed = body.seed;
  }

  try {
    const result = await spinBacklog(steamId, {
      category: body.category,
      exclude,
      sessionId,
      seed,
    });
    return jsonResponse(result);
  } catch (error) {
    logServerError('Backlog spin failed', error);
    return errorResponse('unavailable', 'Backlog spin is unavailable right now');
  }
}
