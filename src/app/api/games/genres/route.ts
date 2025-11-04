import { NextResponse } from 'next/server';
import fetch from 'node-fetch';

export async function POST(req: Request) {
  try {
    const { appids } = await req.json();

    if (!appids || !Array.isArray(appids) || appids.length === 0) {
      return NextResponse.json(
        { error: 'App IDs array is required' },
        { status: 400 }
      );
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
          const response = await fetch(
            `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us`
          );
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data = await response.json();
          const gameData = data[appid.toString()]?.data;
          
          if (gameData?.genres && Array.isArray(gameData.genres)) {
            const gameGenres = gameData.genres
              .map((g: any) => g.description)
              .filter((g: string) => g); // Filter out empty strings
            
            if (gameGenres.length > 0) {
              genresMap[appid] = gameGenres;
            }
          }
        } catch (error) {
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
    console.error('Error in genres API route:', error);
    return NextResponse.json(
      { error: 'Failed to fetch genres' },
      { status: 500 }
    );
  }
}

