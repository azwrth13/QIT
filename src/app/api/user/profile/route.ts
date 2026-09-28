import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { logServerError, steamApiUrl, steamJson } from '@/lib/steam';
import { SteamProfileResponse } from '@/types/api';

export async function GET() {
  try {
    const steamId = await getSteamId();
    if (!steamId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const profileData = await steamJson<SteamProfileResponse>(steamApiUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }));

    const profile = profileData.response.players[0];
    if (!profile) {
      return NextResponse.json({ error: 'Profile not found.' }, { status: 404 });
    }

    // Optionally, fetch additional data or perform transformations here

    // Return the necessary profile data
    return NextResponse.json({
      steamId: profile.steamid,
      personaName: profile.personaname,
      profileUrl: profile.profileurl,
      avatarFull: profile.avatarfull,
    });
  } catch (error) {
    logServerError('Error fetching user profile', error);
    return NextResponse.json(
      { error: 'Internal Server Error while fetching profile.' },
      { status: 500 }
    );
  }
}
