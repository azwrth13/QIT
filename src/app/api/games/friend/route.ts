import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import type { Game } from '@/lib/games';
import { createLimiter } from '@/lib/http/guards';
import { getSteamLibrary } from '@/lib/social/libraries';
import { isSteamId, logServerError } from '@/lib/steam';

// Per signed-in user, per server instance: a burst of 20 lookups, then one every three seconds.
const limiter = createLimiter({ capacity: 20, refillPerSecond: 1 / 3 });
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(req: Request) {
  const userId = await getSteamId();
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const steamId = new URL(req.url).searchParams.get('steamid');
  if (!isSteamId(steamId)) return NextResponse.json({ error: 'Enter a valid Steam ID.' }, { status: 400 });
  const wait = limiter.take(userId);
  if (wait) {
    return NextResponse.json({ error: 'Too many friend lookups. Please wait a moment and try again.' },
      { status: 429, headers: { ...headers, 'Retry-After': String(wait) } });
  }
  try {
    // Always Steam (repeat lookups from its 30-minute cache), never another user's stored QIT index.
    const library = await getSteamLibrary(steamId);
    if (library.state === 'not_found') return NextResponse.json({ error: 'Steam profile not found.' }, { status: 404, headers });
    if (library.state === 'private') {
      return NextResponse.json({ error: 'This friend’s game details are private. Ask them to set Game details to Public in Steam.' }, { status: 403, headers });
    }
    if (library.state === 'error') return NextResponse.json({ error: 'Could not load this friend’s library. Please try again.' }, { status: 502, headers });
    const games: Game[] = [...library.games].map(([appid, game]) => ({
      appid, name: game.n, img_icon_url: game.i ?? '', playtime_forever: game.p ?? 0,
    }));
    return NextResponse.json({ games }, { headers });
  } catch (error) {
    logServerError('Friend library request failed', error);
    return NextResponse.json({ error: 'Could not load this friend’s library. Please try again.' }, { status: 502, headers });
  }
}
