import { NextResponse } from 'next/server';
import { baseUrl, getSteamProfile, logServerError, OPENID_ENDPOINT, validateOpenId } from '@/lib/steam';
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { AUTO_SYNC_COOKIE, ensureUser } from '@/lib/library-data';

function loginError(req: Request, code: string) {
  let origin: string;
  try { origin = baseUrl(); } catch { origin = req.url; }
  return NextResponse.redirect(new URL(`/?login_error=${code}`, origin));
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const steamId = validateOpenId(params, `${baseUrl()}/api/auth/steam-callback`);
    if (!steamId) return loginError(req, 'invalid_steam_id');
    const verifyParams = new URLSearchParams();
    for (const [key, value] of params) {
      if (key.startsWith('openid.')) verifyParams.set(key, value);
    }
    verifyParams.set('openid.mode', 'check_authentication');
    const verification = await fetch(OPENID_ENDPOINT, {
      method: 'POST', body: verifyParams, cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    if (!verification.ok) return loginError(req, 'steam_verification_unavailable');
    const body = await verification.text();
    if (!body.split(/\r?\n/).includes('is_valid:true')) return loginError(req, 'verification_failed');
    const profile = await getSteamProfile(steamId);
    if (!profile) return loginError(req, 'profile_not_found');
    await ensureUser(steamId, profile.profileUrl);
    const response = NextResponse.redirect(`${baseUrl()}/library`);
    response.cookies.set(SESSION_COOKIE, await createSession(steamId), sessionCookieOptions);
    response.cookies.set('steamid', '', { ...sessionCookieOptions, maxAge: 0 });
    response.cookies.set(AUTO_SYNC_COOKIE, '1', sessionCookieOptions);
    return response;
  } catch (error) {
    logServerError('Steam login failed', error);
    return loginError(req, 'unexpected_failure');
  }
}
