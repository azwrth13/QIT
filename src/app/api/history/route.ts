import { getSteamId } from '@/lib/auth';
import { listRolls, markAccepted, markPlayed, markRerolled, decodeRollCursor, MAX_ROLLS_PAGE, type RollView, type TransitionResult } from '@/lib/history/rolls';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, readJsonBody } from '@/lib/http/guards';
import { logServerError } from '@/lib/steam';

// GET  /api/history?limit=&cursor=      the signed-in user's rolls, newest first, paged
// PATCH /api/history { rollId, action }  action: accept | reroll | played (a manual "I played it")

const readLimits = { user: createLimiter({ capacity: 30, refillPerSecond: 1 }), ip: createLimiter({ capacity: 120, refillPerSecond: 4 }) };
const writeLimits = { user: createLimiter({ capacity: 20, refillPerSecond: 0.5 }), ip: createLimiter({ capacity: 60, refillPerSecond: 2 }) };
const ROLL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIONS = ['accept', 'reroll', 'played'] as const;
type Action = typeof ACTIONS[number];

// The shared envelope has no 404 or 409 code; these keep its shape.
const notFound = () => jsonResponse({ error: { code: 'not_found', message: 'Roll not found' } }, 404);
const conflict = (roll: RollView) => jsonResponse({ error: { code: 'conflict', message: `Roll is already ${roll.status}` }, roll }, 409);

export async function GET(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkRateLimit(req, steamId, readLimits);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 20 : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!(limit >= 1 && limit <= MAX_ROLLS_PAGE)) return errorResponse('invalid', `limit must be 1 to ${MAX_ROLLS_PAGE}`);
  const cursor = params.get('cursor') ?? undefined;
  if (cursor !== undefined && !decodeRollCursor(cursor)) return errorResponse('invalid', 'Invalid cursor');
  try {
    return jsonResponse(await listRolls(steamId, { limit, cursor }));
  } catch (error) {
    logServerError('History read failed', error);
    return errorResponse('unavailable', 'History is unavailable right now');
  }
}

export async function PATCH(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, writeLimits);
  if (denied) return denied;
  const parsed = await readJsonBody(req, 1024);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as { rollId?: unknown; action?: unknown } | null;
  const rollId = typeof body?.rollId === 'string' && ROLL_ID.test(body.rollId) ? body.rollId : null;
  const action = ACTIONS.includes(body?.action as Action) ? body!.action as Action : null;
  if (!rollId) return errorResponse('invalid', 'Invalid roll ID');
  if (!action) return errorResponse('invalid', `action must be one of ${ACTIONS.join(', ')}`);
  let result: TransitionResult;
  try {
    result = action === 'accept' ? await markAccepted(steamId, rollId)
      : action === 'reroll' ? await markRerolled(steamId, rollId)
        : await markPlayed(steamId, rollId, 'manual');
  } catch (error) {
    logServerError('History update failed', error);
    return errorResponse('unavailable', 'History is unavailable right now');
  }
  if (result.outcome === 'not_found') return notFound();
  if (result.outcome === 'conflict') return conflict(result.roll);
  return jsonResponse({ outcome: result.outcome, roll: result.roll });
}
