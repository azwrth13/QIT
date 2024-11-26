// steam-callback/route.ts

import { PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';
import fetch from 'node-fetch';

// Importing interfaces from your type files
import { SteamOwnedGamesResponse, SteamGame } from '../../../../../types/steam';

const prisma = new PrismaClient();
const STEAM_API_KEY = process.env.STEAM_API_KEY;

// -----------------------------
// TypeScript Interfaces
// -----------------------------

// Interface for the Steam Profile API response
interface SteamProfileResponse {
  response: {
    players: {
      steamid: string;
      profileurl: string;
      avatarfull: string;
      personaname: string;
    }[];
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = new URLSearchParams(url.search);

  // Add OpenID check_authentication
  params.set('openid.mode', 'check_authentication');
  const verifyUrl = 'https://steamcommunity.com/openid/login';

  console.log('Sending OpenID authentication request to Steam.');

  const response = await fetch(verifyUrl, {
    method: 'POST',
    body: params,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 
    },
  });

  const body = await response.text();

  console.log('Received OpenID authentication response from Steam.');

  if (!body.includes('is_valid:true')) {
    console.warn('Invalid login attempt detected.');
    return NextResponse.json({ error: 'Invalid login attempt' }, { status: 401 });
  }

  const steamIdMatch = params.get('openid.claimed_id')?.match(/\d+$/);
  const steamId = steamIdMatch ? steamIdMatch[0] : null;

  if (!steamId) {
    console.warn('Unable to retrieve Steam ID from OpenID response.');
    return NextResponse.json({ error: 'Unable to retrieve Steam ID' }, { status: 400 });
  }

  console.log(`Extracted Steam ID: ${steamId}`);

  // Fetch user's Steam profile
  const profileUrlApi = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`;
  console.log(`Fetching profile data from: ${profileUrlApi}`);

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
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
  }

  // Upsert user in the database
  const user = await prisma.user.upsert({
    where: { steamId },
    update: { profileUrl: profile.profileurl },
    create: {
      steamId,
      profileUrl: profile.profileurl,
    },
  });

  console.log('User upserted:', JSON.stringify(user, null, 2));

  // -----------------------------
  // Fetch and Upsert User's Games
  // -----------------------------

  // Fetch user's owned games from Steam API
  const gamesUrlApi = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&include_appinfo=true`;
  console.log(`Fetching games data from: ${gamesUrlApi}`);

  const gamesRes = await fetch(gamesUrlApi);
  if (!gamesRes.ok) {
    console.error(`Failed to fetch games data: ${gamesRes.statusText}`);
    return NextResponse.json(
      { error: 'Failed to fetch games data from Steam.' },
      { status: 500 }
    );
  }

  const gamesData = (await gamesRes.json()) as SteamOwnedGamesResponse;
  console.log('Games data fetched:', JSON.stringify(gamesData, null, 2));

  const games = gamesData.response.games;
  if (!games || games.length === 0) {
    console.warn(`No games found for Steam ID: ${steamId}`);
    
  } else {
    console.log(`Found ${games.length} games for Steam ID: ${steamId}`);

    // Insert or update games in the database
    const gamePromises = games.map(async (game: SteamGame) => {
      try {
        // Check if the game already exists for this user
        const existingGame = await prisma.game.findFirst({
          where: {
            appid: game.appid,
            userId: user.id,
          },
        });

        if (existingGame) {
          // Update the existing game entry
          const updatedGame = await prisma.game.update({
            where: { id: existingGame.id },
            data: {
              name: game.name,
              img_icon_url: game.img_icon_url || '',
              playtime_forever: game.playtime_forever || 0,
            },
          });
          console.log(`Game updated: ${JSON.stringify(updatedGame, null, 2)}`);
        } else {
          // Create a new game entry
          const newGame = await prisma.game.create({
            data: {
              appid: game.appid,
              name: game.name,
              img_icon_url: game.img_icon_url || '',
              playtime_forever: game.playtime_forever || 0,
              userId: user.id,
            },
          });
          console.log(`Game created: ${JSON.stringify(newGame, null, 2)}`);
        }
      } catch (err) {
        console.error(`Error upserting game with appid ${game.appid}:`, err);
      }
    });

    // Wait for all game upsert operations to complete
    await Promise.all(gamePromises);
    console.log('All games have been upserted successfully.');
  }

  // -----------------------------
  // Redirect User After Successful Operation
  // -----------------------------

  // Generate an absolute URL for redirection
  const redirectUrl = new URL('/', req.url);
  redirectUrl.searchParams.set('success', 'true');
  redirectUrl.searchParams.set('user', user.id.toString());

  console.log(`Redirecting user to: ${redirectUrl.toString()}`);

  // Create a NextResponse redirect
  const nextResponse = NextResponse.redirect(redirectUrl.toString());

  // -----------------------------
  // Add Cookie to Save Steam ID
  // -----------------------------

  nextResponse.cookies.set('steamid', steamId, {
    httpOnly: true, // Prevents client-side JavaScript from accessing the cookie
    secure: process.env.NODE_ENV === 'production', // Ensures the cookie is sent over HTTPS in production
    sameSite: 'lax', // Helps protect against CSRF attacks
    path: '/', // Makes the cookie accessible on all routes
    maxAge: 60 * 60 * 24 * 7, // 1 week in seconds
  });

  console.log(`Set 'steamid' cookie and redirecting to: ${redirectUrl.toString()}`);

  return nextResponse;
}
