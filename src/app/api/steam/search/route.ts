import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { isSteamId, logServerError, parseSteamSearch, steamApiUrl, steamJson } from '@/lib/steam';
import { SteamProfileResponse } from '@/types/api';

export async function GET(req: Request) {
  try {
    if (!await getSteamId()) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const query = new URL(req.url).searchParams.get('q');
    const input = query && query.length <= 256 ? parseSteamSearch(query) : null;
    if (!input) return NextResponse.json({ error: 'Invalid Steam ID or profile URL' }, { status: 400 });
    let steamId: unknown;
    if ('steamId' in input) steamId = input.steamId;
    else {
      const resolved = await steamJson<{ response: { steamid?: string } }>(steamApiUrl('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: input.vanity }));
      steamId = resolved.response.steamid;
    }
    if (!isSteamId(steamId)) return NextResponse.json({ error: 'Steam profile not found' }, { status: 404 });
    const data = await steamJson<SteamProfileResponse>(steamApiUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }));
    const player = data.response.players.find(player => player.steamid === steamId);
    if (!player) return NextResponse.json({ error: 'Steam profile not found' }, { status: 404 });
    return NextResponse.json({
      steamId: player.steamid, personaName: player.personaname, profileUrl: player.profileurl,
      avatarFull: player.avatarfull, avatarMedium: player.avatarmedium,
      communityVisibilityState: player.communityvisibilitystate, profileState: player.profilestate,
    });
  } catch (error) {
    logServerError('Error searching Steam profile', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
