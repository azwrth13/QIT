import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { logServerError } from '@/lib/steam';
import { getFriends } from '@/lib/social/friends';

// `{ friends, message?, source }`: the shape the home page reads is `friends` and `message`. Each friend now
// also carries `status` and `currentGame` when Steam shares them.
export async function GET() {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  try {
    return NextResponse.json(await getFriends(steamId), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch (error) {
    logServerError('Steam friends lookup failed', error);
    return NextResponse.json({ error: 'Could not load Steam friends. Please try again.' }, { status: 502 });
  }
}
