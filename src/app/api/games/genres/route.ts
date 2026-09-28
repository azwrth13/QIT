import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { getStoredGames } from '@/lib/library-data';
import { logServerError } from '@/lib/steam';

const genreCache = new Map<number, { genres: string[]; expires: number }>();
const day = 24 * 60 * 60 * 1000;

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  let appids: unknown;
  try { ({ appids } = await req.json()); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  if (!Array.isArray(appids) || appids.length === 0 || appids.length > 3000 || appids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    return NextResponse.json({ error: 'Enter up to 3000 valid app IDs.' }, { status: 400 });
  }
  const ids = [...new Set(appids as number[])];
  try {
    const owned = new Set((await getStoredGames(steamId)).map(game => game.appid));
    if (ids.some(id => !owned.has(id))) return NextResponse.json({ error: 'App IDs must belong to your library' }, { status: 400 });
  } catch (error) {
    logServerError('Genre ownership check failed', error);
    return NextResponse.json({ error: 'Unable to check library ownership' }, { status: 500 });
  }
  const genres: Record<number, string[]> = {};
  let errorCount = 0;
  const missing: number[] = [];
  for (const id of ids) {
    const cached = genreCache.get(id);
    if (cached && cached.expires > Date.now()) genres[id] = cached.genres;
    else missing.push(id);
  }
  for (let start = 0; start < missing.length; start += 4) {
    await Promise.all(missing.slice(start, start + 4).map(async id => {
      try {
        const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=us`, { signal: AbortSignal.timeout(10000), next: { revalidate: 86400 } });
        if (!response.ok) throw new Error('Store request failed');
        const data = await response.json();
        if (!data[id]?.success) throw new Error('Store has no details');
        const list = (data[id].data?.genres || []).map((entry: { description: string }) => entry.description).filter(Boolean);
        genres[id] = list;
        genreCache.set(id, { genres: list, expires: Date.now() + day });
      } catch { errorCount++; }
    }));
    if (start + 4 < missing.length) await new Promise(resolve => setTimeout(resolve, 300));
  }
  return NextResponse.json({ genres, successCount: ids.length - errorCount, errorCount, totalRequested: ids.length });
}
