// steam-callback/logout.ts

import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';

export async function GET(req: Request) {
  const redirectUrl = new URL('/', req.url);
  const response = NextResponse.redirect(redirectUrl.toString());

  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions, maxAge: 0 });

  // Also remove the obsolete unsigned cookie.
  response.cookies.set('steamid', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: new Date(0), // Sets the cookie to expire in the past
  });



  return response;
}
