import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { ownsGames } from '@/lib/library-data';
import { getGenresForApps } from '@/lib/genre-cache';
import { logServerError } from '@/lib/steam';
import { MAX_GENRE_APPIDS, validateAppIds } from '@/lib/genres';

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  const ids = validateAppIds(body);
  if (!ids) return NextResponse.json({ error: `Enter up to ${MAX_GENRE_APPIDS} unique valid app IDs.` }, { status: 400 });
  try {
    if (!await ownsGames(steamId, ids)) return NextResponse.json({ error: 'App IDs must belong to your library' }, { status: 400 });
    const genres = await getGenresForApps(ids);
    return NextResponse.json({ genres, successCount: Object.keys(genres).length,
      errorCount: ids.length - Object.keys(genres).length, totalRequested: ids.length });
  } catch (error) {
    logServerError('Genre lookup failed', error);
    return NextResponse.json({ error: 'Unable to load genres' }, { status: 502 });
  }
}
