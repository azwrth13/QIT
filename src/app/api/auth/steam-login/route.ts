import { NextResponse } from 'next/server';
import { OPENID_ENDPOINT, OPENID_NAMESPACE } from '@/lib/steam';
import { getBaseUrl } from '@/lib/base-url';
import { createPreAuthSession, isValidNextPath, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';

export async function GET(req: Request) {
  const reqUrl = new URL(req.url);
  const next = reqUrl.searchParams.get('next');
  
  const baseUrl = getBaseUrl(req);
  const url = new URL(OPENID_ENDPOINT);
  url.search = new URLSearchParams({
    'openid.ns': OPENID_NAMESPACE,
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${baseUrl}/api/auth/steam-callback`,
    'openid.realm': baseUrl,
    'openid.identity': `${OPENID_NAMESPACE}/identifier_select`,
    'openid.claimed_id': `${OPENID_NAMESPACE}/identifier_select`,
  }).toString();
  
  const response = NextResponse.redirect(url);
  if (isValidNextPath(next)) {
    response.cookies.set(SESSION_COOKIE, await createPreAuthSession(next), sessionCookieOptions);
  }
  return response;
}
