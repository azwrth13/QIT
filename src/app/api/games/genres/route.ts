import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { logServerError, steamJson } from '@/lib/steam';
import { validateAppIds } from '@/lib/genres';
import prisma from '../../../library/prisma';

export async function POST(req: Request) {
  try {
    const steamId = await getSteamId();
    if (!steamId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    let body: unknown;
    try { body = await req.json(); }
    catch { return NextResponse.json({ error: 'Malformed JSON' }, { status: 400 }); }
    const appids = validateAppIds(body);
    if (!appids) return NextResponse.json({ error: 'Provide 1–500 unique positive integer appids' }, { status: 400 });
    const user = await prisma.user.findUnique({ where: { steamId }, select: { games: { select: { appid: true } } } });
    const owned = new Set(user?.games.map(game => game.appid));
    if (appids.length > owned.size || appids.some(id => !owned.has(id))) {
      return NextResponse.json({ error: 'App IDs must belong to your library' }, { status: 400 });
    }

    // Batch size for rate limiting (Steam API can handle ~20-30 requests at a time)
    const batchSize = 20;
    const delayBetweenBatches = 200; // milliseconds
    const genresMap: Record<number, string[]> = {};
    const errors: number[] = [];

    // Process games in batches
    for (let i = 0; i < appids.length; i += batchSize) {
      const batch = appids.slice(i, i + batchSize);
      
      // Fetch genres for each game in the batch
      const promises = batch.map(async (appid: number) => {
        try {
          const url = new URL('https://store.steampowered.com/api/appdetails');
          url.search = new URLSearchParams({ appids: String(appid), cc: 'us' }).toString();
          const data = await steamJson<Record<string, { data?: { genres?: { description: string }[] } }>>(url);
          const gameData = data[appid.toString()]?.data;
          
          if (gameData?.genres && Array.isArray(gameData.genres)) {
            const gameGenres = gameData.genres
              .map((g) => g.description)
              .filter((g: string) => g); // Filter out empty strings
            
            if (gameGenres.length > 0) {
              genresMap[appid] = gameGenres;
            }
          }
        } catch {
          // Silently track errors without logging each one
          errors.push(appid);
        }
      });

      // Wait for all promises in the batch to complete
      await Promise.all(promises);

      // Add delay between batches to avoid rate limiting (except for the last batch)
      if (i + batchSize < appids.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }

    // Return genres map and summary
    return NextResponse.json({
      genres: genresMap,
      successCount: Object.keys(genresMap).length,
      errorCount: errors.length,
      totalRequested: appids.length,
    });
  } catch (error) {
    logServerError('Error in genres API route', error);
    return NextResponse.json(
      { error: 'Failed to fetch genres' },
      { status: 500 }
    );
  }
}

