import { getSteamId } from '@/lib/auth';
import { db } from '@/lib/firestore';
import { paths } from '@/lib/store/paths';
import { isValidTimeZone } from '@/lib/history/time';
import { EXCLUSION_SCOPES, ExclusionLimitError, addExclusion, endExclusionSession, listExclusions, removeExclusion } from '@/lib/history/exclusions';
import type { ExclusionScope } from '@/lib/store/types';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, parseAppId, readJsonBody } from '@/lib/http/guards';
import { logServerError } from '@/lib/steam';

const limits = { user: createLimiter({ capacity: 60, refillPerSecond: 1 }), ip: createLimiter({ capacity: 120, refillPerSecond: 2 }) };
const sessionValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

export async function GET(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  try {
    return jsonResponse({ exclusions: await listExclusions(steamId) });
  } catch (error) {
    logServerError('Exclusions lookup failed', error);
    return errorResponse('unavailable', 'Unable to load hidden games');
  }
}

/** All mutations use one guarded POST: hide, unhide, or end-session. Identity comes only from the cookie. */
export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  const parsed = await readJsonBody(req, 1024);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('invalid', 'Invalid exclusion request');
  const appid = parseAppId(body.appid);
  if (body.action === 'end-session') {
    if (!sessionValid(body.sessionId)) return errorResponse('invalid', 'Invalid session ID');
  } else if (!appid || appid > 9999999999 || !['hide', 'unhide'].includes(String(body.action))) {
    return errorResponse('invalid', 'Invalid exclusion request');
  }
  if (body.action === 'hide' && (!EXCLUSION_SCOPES.includes(body.scope as ExclusionScope) ||
    (body.scope === 'session' ? !sessionValid(body.sessionId) : body.sessionId !== undefined))) {
    return errorResponse('invalid', 'Invalid scope or session ID');
  }
  try {
    if (body.action === 'end-session') return jsonResponse({ removed: await endExclusionSession(steamId, body.sessionId as string) });
    if (body.action === 'unhide') return jsonResponse({ removed: await removeExclusion(steamId, appid!) });
    const tz = body.scope === 'day' ? (await db.doc(paths.user(steamId)).get()).get('tz') : undefined;
    if (body.scope === 'day' && !isValidTimeZone(tz)) return errorResponse('invalid', 'Save your profile timezone before using Not tonight');
    return jsonResponse({ exclusion: await addExclusion(steamId, appid!, body.scope as ExclusionScope, {
      ...(body.scope === 'session' ? { sessionId: body.sessionId as string } : {}), tz,
    }) });
  } catch (error) {
    if (error instanceof ExclusionLimitError) return errorResponse('invalid', error.message);
    logServerError('Exclusion update failed', error);
    return errorResponse('unavailable', 'Unable to update hidden games');
  }
}
