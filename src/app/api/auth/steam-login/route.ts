import { NextResponse } from 'next/server';
import { baseUrl, OPENID_ENDPOINT, OPENID_NAMESPACE } from '@/lib/steam';

export async function GET() {
  const url = new URL(OPENID_ENDPOINT);
  url.search = new URLSearchParams({
    'openid.ns': OPENID_NAMESPACE,
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${baseUrl()}/api/auth/steam-callback`,
    'openid.realm': baseUrl(),
    'openid.identity': `${OPENID_NAMESPACE}/identifier_select`,
    'openid.claimed_id': `${OPENID_NAMESPACE}/identifier_select`,
  }).toString();
  return NextResponse.redirect(url);
}
