import { getSteamId } from '@/lib/auth';
import {
  acceptChallenge, declineChallenge, decodeChallengeCursor, issueChallenge, listChallenges, validateChallengeInput, verifyChallenge,
  MAX_CHALLENGES_PAGE, type ChallengeInput, type ChallengeView, type IssueResult, type VerifyResult,
} from '@/lib/history/challenges';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, readJsonBody } from '@/lib/http/guards';
import { logServerError } from '@/lib/steam';
import { SteamClientError } from '@/lib/steam/client';

// GET   /api/challenges?status=active|all&limit=&cursor=   the signed-in user's challenges, newest first
// POST  /api/challenges { kind, appid, apiname?, threshold?, count? }   issue a challenge
// PATCH /api/challenges { challengeId, action }   action: accept | decline | verify

const readLimits = { user: createLimiter({ capacity: 30, refillPerSecond: 1 }), ip: createLimiter({ capacity: 120, refillPerSecond: 4 }) };
const writeLimits = { user: createLimiter({ capacity: 20, refillPerSecond: 0.5 }), ip: createLimiter({ capacity: 60, refillPerSecond: 2 }) };
// Verify and issue can each cost a keyed Steam call.
const steamLimits = { user: createLimiter({ capacity: 10, refillPerSecond: 0.2 }), ip: createLimiter({ capacity: 40, refillPerSecond: 1 }) };
const CHALLENGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIONS = ['accept', 'decline', 'verify'] as const;
type Action = typeof ACTIONS[number];
const RATE_LIMIT_RETRY_SECONDS = 30;

// The shared envelope has no 404 or 409 codes; these keep its shape.
const notFound = (message: string, code = 'not_found') => jsonResponse({ error: { code, message } }, 404);
const conflict = (challenge: ChallengeView) =>
  jsonResponse({ error: { code: 'conflict', message: `Challenge is already ${challenge.status}` }, challenge }, 409);
const issueRefusal = (code: string, message: string) => jsonResponse({ error: { code, message } }, 409);

const ISSUE_MESSAGES: Record<Exclude<IssueResult['outcome'], 'created' | 'existing' | 'not_owned'>, string> = {
  needs_sync: 'Sync your library first, then try again.',
  private: 'Steam is not sharing your achievements. Set Game details to Public in your Steam privacy settings, then try again.',
  no_achievements: 'This game has no achievements on Steam.',
  not_locked: 'That achievement is not locked for you, or the game does not have enough locked achievements.',
  limit: 'You have too many open challenges. Finish or decline one first.',
};
const PRIVATE_MESSAGE = ISSUE_MESSAGES.private;

/** Steam throttling becomes a 429 with Retry-After; anything else is the shared 502. */
function failure(error: unknown, label: string): Response {
  if (error instanceof SteamClientError && (error.kind === 'rate_limited' || error.kind === 'budget_exhausted')) {
    return errorResponse('rate_limited', 'Steam is busy right now. Try again shortly.', { 'Retry-After': String(error.retryAfterSeconds ?? RATE_LIMIT_RETRY_SECONDS) });
  }
  logServerError(label, error);
  return errorResponse('unavailable', 'Challenges are unavailable right now');
}

export async function GET(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkRateLimit(req, steamId, readLimits);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const status = params.get('status') ?? 'all';
  if (status !== 'active' && status !== 'all') return errorResponse('invalid', 'status must be active or all');
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 20 : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!(limit >= 1 && limit <= MAX_CHALLENGES_PAGE)) return errorResponse('invalid', `limit must be 1 to ${MAX_CHALLENGES_PAGE}`);
  const cursor = params.get('cursor') ?? undefined;
  if (cursor !== undefined && (status === 'active' || !decodeChallengeCursor(cursor))) return errorResponse('invalid', 'Invalid cursor');
  try {
    return jsonResponse(await listChallenges(steamId, { status, limit, cursor }));
  } catch (error) {
    return failure(error, 'Challenge list failed');
  }
}

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, steamLimits);
  if (denied) return denied;
  const parsed = await readJsonBody(req, 1024);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as Partial<Record<keyof ChallengeInput, unknown>> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('invalid', 'Invalid request body');
  let input: ChallengeInput;
  try {
    input = validateChallengeInput({
      kind: body.kind, appid: body.appid, apiname: body.apiname, threshold: body.threshold, count: body.count,
    } as ChallengeInput);
  } catch (error) {
    return errorResponse('invalid', error instanceof Error ? error.message : 'Invalid challenge');
  }
  let result: IssueResult;
  try {
    result = await issueChallenge(steamId, input);
  } catch (error) {
    return failure(error, 'Challenge issue failed');
  }
  if (result.outcome === 'created' || result.outcome === 'existing') {
    return jsonResponse({ outcome: result.outcome, challenge: result.challenge }, result.outcome === 'created' ? 201 : 200);
  }
  if (result.outcome === 'not_owned') return notFound('That game is not in your library', 'not_owned');
  return issueRefusal(result.outcome, ISSUE_MESSAGES[result.outcome]);
}

export async function PATCH(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const sameOrigin = checkSameOrigin(req);
  if (sameOrigin) return sameOrigin;
  const parsed = await readJsonBody(req, 1024);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as { challengeId?: unknown; action?: unknown } | null;
  const challengeId = typeof body?.challengeId === 'string' && CHALLENGE_ID.test(body.challengeId) ? body.challengeId : null;
  const action = ACTIONS.includes(body?.action as Action) ? body!.action as Action : null;
  if (!challengeId) return errorResponse('invalid', 'Invalid challenge ID');
  if (!action) return errorResponse('invalid', `action must be one of ${ACTIONS.join(', ')}`);
  const denied = checkRateLimit(req, steamId, action === 'verify' ? steamLimits : writeLimits);
  if (denied) return denied;
  let result: VerifyResult;
  try {
    result = action === 'accept' ? await acceptChallenge(steamId, challengeId)
      : action === 'decline' ? await declineChallenge(steamId, challengeId)
        : await verifyChallenge(steamId, challengeId);
  } catch (error) {
    return failure(error, 'Challenge update failed');
  }
  switch (result.outcome) {
    case 'not_found': return notFound('Challenge not found');
    case 'conflict': return conflict(result.challenge);
    case 'pending': return jsonResponse({ outcome: 'pending', challenge: result.challenge, progress: result.progress });
    case 'private': return jsonResponse({ outcome: 'private', challenge: result.challenge, message: PRIVATE_MESSAGE });
    default: return jsonResponse({ outcome: result.outcome, challenge: result.challenge });
  }
}
