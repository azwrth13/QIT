import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, NO_STORE, readJsonBody } from '@/lib/http/guards';
import { deleteUserData } from '@/lib/privacy/data';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { logServerError } from '@/lib/steam';

const limits = { user: createLimiter({ capacity: 3, refillPerSecond: 1 / 60 }), ip: createLimiter({ capacity: 10, refillPerSecond: 1 / 10 }) };

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  const parsed = await readJsonBody(req, 512);
  if ('response' in parsed) return parsed.response;
  if ((parsed.body as { confirmation?: unknown } | null)?.confirmation !== 'DELETE MY DATA') {
    return errorResponse('invalid', 'Confirm deletion with DELETE MY DATA');
  }
  try {
    await deleteUserData(steamId);
    const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': NO_STORE, 'Vary': 'Cookie' } });
    response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions, maxAge: 0 });
    return response;
  } catch (error) {
    logServerError('Data deletion failed', error);
    return errorResponse('unavailable', 'Deletion did not finish. Please retry to remove any remaining data.');
  }
}
