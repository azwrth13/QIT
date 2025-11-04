// app/api/user/profile/route.ts

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import fetch from 'node-fetch';
import prisma from '../../library/prisma';
import { SteamProfileResponse } from '../../../types/api';

const STEAM_API_KEY = process.env.STEAM_API_KEY;

export async function GET() {
  try {
    // Access cookies from the request
    const cookieStore = await cookies();
    const steamId = cookieStore.get('steamid')?.value;

    if (!steamId) {
      console.warn('Steam ID not found in cookies.');
      return NextResponse.json(
        { error: 'Not authenticated. Steam ID is missing.' },
        { status: 401 }
      );
    }

    console.log(`Fetching profile data for Steam ID: ${steamId}`);

    // Fetch user's Steam profile
    const profileUrlApi = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`;

    const profileRes = await fetch(profileUrlApi);
    if (!profileRes.ok) {
      console.error(`Failed to fetch profile data: ${profileRes.statusText}`);
      return NextResponse.json(
        { error: 'Failed to fetch profile data from Steam.' },
        { status: 500 }
      );
    }

    const profileData = (await profileRes.json()) as SteamProfileResponse;
    console.log('Profile data fetched:', JSON.stringify(profileData, null, 2));

    const profile = profileData.response.players[0];
    if (!profile) {
      console.warn(`Profile not found for Steam ID: ${steamId}`);
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
    console.error('Error fetching user profile:', error);
    return NextResponse.json(
      { error: 'Internal Server Error while fetching profile.' },
      { status: 500 }
    );
  }
}
