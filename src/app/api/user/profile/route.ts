import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, readJsonBody } from '@/lib/http/guards';
import { isValidTimeZone } from '@/lib/history/time';
import { setProfileTimeZone } from '@/lib/profile/timezone';
import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { logServerError } from '@/lib/steam';
import { getStoredProfile } from '@/lib/library-data';

export async function GET() {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Not authenticated. Steam ID is missing.' }, { status: 401 });
  try {
    const profile = await getStoredProfile(steamId);
    if (!profile) return NextResponse.json({ error: 'Profile not found.' }, { status: 404 });
    return NextResponse.json(profile, { headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' } });
  } catch (error) {
    logServerError('Profile lookup failed', error);
    return NextResponse.json({ error: 'Unable to load Steam profile.' }, { status: 502 });
  }
}

const timezoneLimits = { user: createLimiter({ capacity: 10, refillPerSecond: 0.1 }), ip: createLimiter({ capacity: 40, refillPerSecond: 1 }) };

/** Stores the browser zone once, or an explicit timezone settings change. */
export async function PATCH(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, timezoneLimits);
  if (denied) return denied;
  const parsed = await readJsonBody(req, 512);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as { tz?: unknown; onlyIfMissing?: unknown } | null;
  if (!body || !isValidTimeZone(body.tz) || (body.onlyIfMissing !== undefined && typeof body.onlyIfMissing !== 'boolean')) {
    return errorResponse('invalid', 'A valid IANA timezone is required');
  }
  try {
    const tz = await setProfileTimeZone(steamId, body.tz, body.onlyIfMissing === true);
    return tz === null ? jsonResponse({ error: { code: 'not_found', message: 'Profile not found' } }, 404) : jsonResponse({ tz });
  } catch (error) {
    logServerError('Timezone update failed', error);
    return errorResponse('unavailable', 'Unable to save timezone');
  }
}
