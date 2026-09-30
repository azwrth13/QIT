import { NextResponse } from 'next/server';
import { getSteamProfile, logServerError, OPENID_ENDPOINT, validateOpenId } from '@/lib/steam';
import { getBaseUrl } from '@/lib/base-url';
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { ensureUser } from '@/lib/library-data';

function loginError(req: Request, code: string) {
  return NextResponse.redirect(new URL(`/?login_error=${code}`, getBaseUrl(req)));
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const steamId = validateOpenId(params, `${getBaseUrl(req)}/api/auth/steam-callback`);
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
    await ensureUser(steamId, profile);
    const response = NextResponse.redirect(`${getBaseUrl(req)}/library?autosync=1`);
    response.cookies.set(SESSION_COOKIE, await createSession(steamId), sessionCookieOptions);
    response.cookies.set('steamid', '', { ...sessionCookieOptions, maxAge: 0 });
    return response;
  } catch (error) {
    logServerError('Steam login failed', error);
    return loginError(req, 'unexpected_failure');
  }
}
