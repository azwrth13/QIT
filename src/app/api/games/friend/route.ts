import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { getPublicLibrary, isSteamId, logServerError } from '@/lib/steam';

export async function GET(req: Request) {
  if (!await getSteamId()) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const steamId = new URL(req.url).searchParams.get('steamid');
  if (!isSteamId(steamId)) return NextResponse.json({ error: 'Enter a valid Steam ID.' }, { status: 400 });
  try {
    const library = await getPublicLibrary(steamId);
    if (library.state === 'unknown') return NextResponse.json({ error: 'Steam profile not found.' }, { status: 404 });
    if (library.state === 'private') return NextResponse.json({ error: 'This friend’s game details are private. Ask them to set Game details to Public in Steam.' }, { status: 403 });
    return NextResponse.json({ games: library.games });
  } catch (error) {
    logServerError('Friend library request failed', error);
    return NextResponse.json({ error: 'Could not load this friend’s library. Please try again.' }, { status: 502 });
  }
}
