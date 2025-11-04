import { NextResponse } from 'next/server';
import fetch from 'node-fetch';

const STEAM_API_KEY = process.env.STEAM_API_KEY;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const friendSteamId = searchParams.get('steamid');

    if (!friendSteamId) {
      return NextResponse.json(
        { error: 'Friend Steam ID is required' },
        { status: 400 }
      );
    }

    if (!STEAM_API_KEY) {
      return NextResponse.json(
        { error: 'Steam API key not configured' },
        { status: 500 }
      );
    }

    // Fetch friend's owned games from Steam API
    const gamesUrlApi = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${friendSteamId}&include_appinfo=true`;
    
    const gamesRes = await fetch(gamesUrlApi);
    
    if (!gamesRes.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch friend games from Steam' },
        { status: 500 }
      );
    }

    const gamesData = await gamesRes.json();
    const games = gamesData.response?.games || [];

    // Format games to match our Game interface
    const formattedGames = games.map((game: any) => ({
      appid: game.appid,
      name: game.name,
      img_icon_url: game.img_icon_url,
      playtime_forever: game.playtime_forever,
    }));

    return NextResponse.json({ games: formattedGames });
  } catch (error) {
    console.error('Error fetching friend games:', error);
    return NextResponse.json(
      { error: 'Error fetching friend games' },
      { status: 500 }
    );
  }
}

