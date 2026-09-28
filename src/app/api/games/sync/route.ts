import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { getSteamProfile, logServerError } from '@/lib/steam';
import { syncLibrary } from '@/lib/library-data';
import { sessionCookieOptions } from '@/lib/session';

export async function POST() {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Sign in with Steam to refresh your library.' }, { status: 401 });
  try {
    const profile = await getSteamProfile(steamId);
    if (!profile) return NextResponse.json({ error: 'Steam profile not found.' }, { status: 404 });
    const result = await syncLibrary(steamId, profile);
    if (result === null) return NextResponse.json({ error: 'Steam could not share this library. Set Game details to Public in Steam privacy settings.' }, { status: 403 });
    const response = NextResponse.json(result);
    response.cookies.set('library-synced', result.lastSynced, sessionCookieOptions);
    return response;
  } catch (error) {
    logServerError('Library sync failed', error);
    return NextResponse.json({ error: 'Unable to refresh your library right now.' }, { status: 502 });
  }
}
