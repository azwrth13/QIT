// steam-callback/logout.ts

import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const redirectUrl = new URL('/', req.url);
  const response = NextResponse.redirect(redirectUrl.toString());

  // Clear the 'steamid' cookie by setting it with an expired date
  response.cookies.set('steamid', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: new Date(0), // Sets the cookie to expire in the past
  });

  console.log('User logged out. Cleared steamid cookie.');

  return response;
}
