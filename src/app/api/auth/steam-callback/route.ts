import { NextResponse } from 'next/server';
import { baseUrl, logServerError, OPENID_ENDPOINT, steamApiUrl, steamJson, validateOpenId } from '@/lib/steam';
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';
import { ensureUser } from '@/lib/library-data';
import { SteamProfileResponse } from '@/types/api';

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
    const profileData = await steamJson<SteamProfileResponse>(steamApiUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }));
    const profile = profileData.response.players.find(player => player.steamid === steamId);
    if (!profile) return loginError(req, 'profile_not_found');
    await ensureUser(steamId, profile.profileurl);
    const response = NextResponse.redirect(`${baseUrl()}/library`);
    response.cookies.set(SESSION_COOKIE, await createSession(steamId), sessionCookieOptions);
    response.cookies.set('steamid', '', { ...sessionCookieOptions, maxAge: 0 });
    response.cookies.set('library-synced', '', { ...sessionCookieOptions, maxAge: 0 });
    return response;
  } catch (error) {
    logServerError('Steam login failed', error);
    return loginError(req, 'unexpected_failure');
  }
}
