import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSteamId } from '@/lib/auth';
import { logServerError } from '@/lib/steam';
import { AUTO_SYNC_COOKIE, getStoredGames } from '@/lib/library-data';
import { sessionCookieOptions } from '@/lib/session';

export async function GET() {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Sign in with Steam to see your library.' }, { status: 401 });
  try {
    const cookieStore = await cookies();
    const games = await getStoredGames(steamId);
    const lastSynced = cookieStore.get('library-synced')?.value || null;
    const signedInNow = cookieStore.get(AUTO_SYNC_COOKIE) !== undefined;
    const response = NextResponse.json({ games, lastSynced, autoSync: signedInNow || (games.length === 0 && !lastSynced) });
    if (signedInNow) response.cookies.set(AUTO_SYNC_COOKIE, '', { ...sessionCookieOptions, maxAge: 0 });
    return response;
  } catch (error) {
    logServerError('Error fetching games', error);
    return NextResponse.json({ error: 'Unable to load your library.' }, { status: 500 });
  }
}
