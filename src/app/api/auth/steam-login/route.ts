import { NextResponse } from 'next/server';

export async function GET() {
  const steamLoginUrl = `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=http://localhost:3000/api/auth/steam-callback&openid.realm=http://localhost:3000&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;
  return NextResponse.redirect(steamLoginUrl);
}
