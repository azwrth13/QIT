import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { isSteamId, logServerError, steamApiUrl, steamJson } from '@/lib/steam';
import { SteamOwnedGamesResponse } from '@/types/api';

export async function GET(req: Request) {
  try {
    if (!await getSteamId()) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const friendSteamId = new URL(req.url).searchParams.get('steamid');
    if (!isSteamId(friendSteamId)) return NextResponse.json({ error: 'Invalid friend Steam ID' }, { status: 400 });
    const data = await steamJson<SteamOwnedGamesResponse>(steamApiUrl('/IPlayerService/GetOwnedGames/v1/', { steamid: friendSteamId, include_appinfo: 'true' }));
    return NextResponse.json({ games: (data.response.games || []).map(game => ({
      appid: game.appid, name: game.name, img_icon_url: game.img_icon_url, playtime_forever: game.playtime_forever,
    })) });
  } catch (error) {
    logServerError('Error fetching friend games', error);
    return NextResponse.json({ error: 'Error fetching friend games' }, { status: 500 });
  }
}
