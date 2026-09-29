import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { logServerError } from '@/lib/steam';
import { getStoredGames, getLastSyncedAt } from '@/lib/library-data';

export async function GET() {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Sign in with Steam to see your library.' }, { status: 401 });
  try {
    const games = await getStoredGames(steamId);
    const lastSynced = await getLastSyncedAt(steamId);
    return NextResponse.json({ games, lastSynced, autoSync: games.length === 0 && !lastSynced });
  } catch (error) {
    logServerError('Error fetching games', error);
    return NextResponse.json({ error: 'Unable to load your library.' }, { status: 500 });
  }
}
