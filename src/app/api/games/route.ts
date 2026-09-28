import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSteamId } from '@/lib/auth';
import { logServerError } from '@/lib/steam';
import { getStoredGames } from '@/lib/library-data';

export async function GET() {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Sign in with Steam to see your library.' }, { status: 401 });
  try {
    const cookieStore = await cookies();
    return NextResponse.json({ games: await getStoredGames(steamId), lastSynced: cookieStore.get('library-synced')?.value || null });
  } catch (error) {
    logServerError('Error fetching games', error);
    return NextResponse.json({ error: 'Unable to load your library.' }, { status: 500 });
  }
}
