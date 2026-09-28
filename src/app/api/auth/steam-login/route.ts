import { NextResponse } from 'next/server';
import { OPENID_ENDPOINT, OPENID_NAMESPACE } from '@/lib/steam';
import { getBaseUrl } from '@/lib/base-url';

export async function GET(req: Request) {
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
  return NextResponse.redirect(url);
}
