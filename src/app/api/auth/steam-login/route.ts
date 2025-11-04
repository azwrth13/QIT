import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  let baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  
  if (!baseUrl) {
    if (process.env.VERCEL_URL) {
      baseUrl = `https://${process.env.VERCEL_URL}`;
    } else {
      baseUrl = 'http://localhost:3000';
    }
  }
  
  const callbackUrl = `${baseUrl}/api/auth/steam-callback`;
  const realm = baseUrl;
  
  const steamLoginUrl = `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(callbackUrl)}&openid.realm=${encodeURIComponent(realm)}&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;
  
  return NextResponse.redirect(steamLoginUrl);
}
