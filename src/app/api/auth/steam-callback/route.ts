// steam-callback/route.ts

import { NextResponse } from 'next/server';
import fetch from 'node-fetch';
import prisma from '../../../library/prisma';
import { SteamOwnedGamesResponse, SteamGame, SteamProfileResponse } from '../../../../types/api';

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const DEBUG = process.env.NODE_ENV === 'development';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = new URLSearchParams(url.search);

  // Log all incoming parameters for debugging
  if (DEBUG) {
    console.log('Received OpenID callback with parameters:');
    for (const [key, value] of params.entries()) {
      console.log(`  ${key}: ${value}`);
    }
  }

  // Extract Steam ID before modifying params for verification
  const steamIdMatch = params.get('openid.claimed_id')?.match(/\d+$/);
  const steamId = steamIdMatch ? steamIdMatch[0] : null;

  if (!steamId) {
    console.warn('Unable to retrieve Steam ID from OpenID response.');
    console.warn('Available openid parameters:', Array.from(params.keys()).filter(k => k.startsWith('openid.')));
    return NextResponse.json({ error: 'Unable to retrieve Steam ID' }, { status: 400 });
  }

  // Verify return_to matches our callback URL
  const returnTo = params.get('openid.return_to');
  let expectedBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  
  if (!expectedBaseUrl) {
    if (process.env.VERCEL_URL) {
      expectedBaseUrl = `https://${process.env.VERCEL_URL}`;
    } else {
      expectedBaseUrl = 'http://localhost:3000';
    }
  }
  
  const expectedReturnTo = `${expectedBaseUrl}/api/auth/steam-callback`;
  
  if (returnTo && returnTo !== expectedReturnTo) {
    console.warn('Return_to mismatch:', {
      expected: expectedReturnTo,
      received: returnTo,
    });
    // Note: Continue anyway as this might be due to URL encoding differences
  }

  // Build verification parameters - preserve all original parameters
  const verifyParams = new URLSearchParams();
  
  // Copy all openid.* parameters to verification request
  for (const [key, value] of params.entries()) {
    if (key.startsWith('openid.')) {
      verifyParams.append(key, value);
    }
  }
  
  // Change mode to check_authentication
  verifyParams.set('openid.mode', 'check_authentication');
  
  const verifyUrl = 'https://steamcommunity.com/openid/login';

  if (DEBUG) {
    console.log('Sending OpenID authentication verification to Steam.');
    console.log('Verification URL:', verifyUrl);
    console.log('Verification parameters count:', verifyParams.toString().split('&').length);
  }

  const response = await fetch(verifyUrl, {
    method: 'POST',
    body: verifyParams.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  if (!response.ok) {
    console.error('Steam verification request failed:', {
      status: response.status,
      statusText: response.statusText,
    });
    return NextResponse.json(
      { error: 'Failed to verify with Steam' },
      { status: 500 }
    );
  }

  const body = await response.text();

  if (DEBUG) {
    console.log('Received OpenID authentication response from Steam.');
    console.log('Verification response:', body);
  }

  if (!body.includes('is_valid:true')) {
    console.error('Invalid login attempt detected.');
    console.error('Verification response body:', body);
    console.error('Verification parameters sent:', verifyParams.toString());
    return NextResponse.json({ error: 'Invalid login attempt' }, { status: 401 });
  }

  if (DEBUG) {
    console.log(`Extracted Steam ID: ${steamId}`);
  }

  // Fetch user's Steam profile
  const profileUrlApi = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`;
  if (DEBUG) {
    console.log(`Fetching profile data from: ${profileUrlApi}`);
  }

  const profileRes = await fetch(profileUrlApi);
  if (!profileRes.ok) {
    console.error(`Failed to fetch profile data: ${profileRes.statusText}`);
    return NextResponse.json(
      { error: 'Failed to fetch profile data from Steam.' },
      { status: 500 }
    );
  }

  const profileData = (await profileRes.json()) as SteamProfileResponse;
  if (DEBUG) {
    console.log('Profile data fetched:', JSON.stringify(profileData, null, 2));
  }

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

  if (DEBUG) {
    console.log('User upserted:', JSON.stringify(user, null, 2));
  }

  // -----------------------------
  // Fetch and Upsert User's Games
  // -----------------------------

  // Fetch user's owned games from Steam API
  const gamesUrlApi = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&include_appinfo=true`;
  if (DEBUG) {
    console.log(`Fetching games data from: ${gamesUrlApi}`);
  }

  const gamesRes = await fetch(gamesUrlApi);
  if (!gamesRes.ok) {
    console.error(`Failed to fetch games data: ${gamesRes.statusText}`);
    return NextResponse.json(
      { error: 'Failed to fetch games data from Steam.' },
      { status: 500 }
    );
  }

  const gamesData = (await gamesRes.json()) as SteamOwnedGamesResponse;
  if (DEBUG) {
    console.log('Games data fetched:', JSON.stringify(gamesData, null, 2));
  }

  const games = gamesData.response.games;
  if (!games || games.length === 0) {
    console.warn(`No games found for Steam ID: ${steamId}`);
    
  } else {
    console.log(`Found ${games.length} games for Steam ID: ${steamId}`);

    try {

    // Optimized batch operations: fetch all existing games in one query with full data for comparison
    const existingGames = await prisma.game.findMany({
      where: { userId: user.id },
      select: { 
        id: true, 
        appid: true,
        name: true,
        img_icon_url: true,
        playtime_forever: true,
      },
    });

    const existingGameMap = new Map(existingGames.map(g => [g.appid, g]));
    const gameAppIds = new Set(games.map(g => g.appid));

    // Separate games into new and existing (only if data has changed)
    const gamesToCreate: SteamGame[] = [];
    const gamesToUpdate: Array<{ id: number; game: SteamGame }> = [];

    games.forEach((game: SteamGame) => {
      const existing = existingGameMap.get(game.appid);
      if (existing) {
        // Only update if data has actually changed
        if (
          existing.name !== game.name ||
          existing.img_icon_url !== (game.img_icon_url || '') ||
          existing.playtime_forever !== (game.playtime_forever || 0)
        ) {
          gamesToUpdate.push({ id: existing.id, game });
        }
        // If unchanged, skip it entirely
      } else {
        gamesToCreate.push(game);
      }
    });

    // Delete games that are no longer in the user's library
    const gamesToDelete = existingGames
      .filter(g => !gameAppIds.has(g.appid))
      .map(g => g.id);

    // Perform all operations in a transaction with improved error handling
    try {
      // Configure transaction timeout: 60 seconds for large game libraries
      // Max timeout is 60 seconds (60000ms) for MySQL
      const timeout = 60000;
      
      await prisma.$transaction(
        async (tx) => {
          // Create new games in batch
          if (gamesToCreate.length > 0) {
            try {
              const result = await tx.game.createMany({
                data: gamesToCreate.map((game: SteamGame) => ({
                  appid: game.appid,
                  name: game.name,
                  img_icon_url: game.img_icon_url || '',
                  playtime_forever: game.playtime_forever || 0,
                  userId: user.id,
                })),
                skipDuplicates: true,
              });
              console.log(`Created ${result.count} new games (${gamesToCreate.length} attempted)`);
            } catch (createError: any) {
              console.error('Error creating games:', createError);
              throw new Error(`Failed to create games: ${createError.message}`);
            }
          }

          // Update existing games in batch
          if (gamesToUpdate.length > 0) {
            try {
              await Promise.all(
                gamesToUpdate.map(({ id, game }) =>
                  tx.game.update({
                    where: { id },
                    data: {
                      name: game.name,
                      img_icon_url: game.img_icon_url || '',
                      playtime_forever: game.playtime_forever || 0,
                    },
                  })
                )
              );
              console.log(`Updated ${gamesToUpdate.length} existing games`);
            } catch (updateError: any) {
              console.error('Error updating games:', updateError);
              throw new Error(`Failed to update games: ${updateError.message}`);
            }
          }

          // Delete games no longer in library
          if (gamesToDelete.length > 0) {
            try {
              const result = await tx.game.deleteMany({
                where: { id: { in: gamesToDelete } },
              });
              console.log(`Deleted ${result.count} games no longer in library`);
            } catch (deleteError: any) {
              console.error('Error deleting games:', deleteError);
              throw new Error(`Failed to delete games: ${deleteError.message}`);
            }
          }
        },
        {
          timeout,
          isolationLevel: 'ReadCommitted', // Use ReadCommitted for better performance
        }
      );

      console.log(`Transaction completed successfully for ${games.length} games`);
      console.log('All games have been upserted successfully.');
    } catch (transactionError: any) {
      // Log detailed error information
      console.error('Transaction failed:', {
        error: transactionError.message,
        code: transactionError.code,
        steamId,
        userId: user.id,
        gamesCount: games.length,
        gamesToCreate: gamesToCreate.length,
        gamesToUpdate: gamesToUpdate.length,
        gamesToDelete: gamesToDelete.length,
        stack: transactionError.stack,
      });

      // Log warning but allow login to continue
      // User can retry syncing games later
      console.warn('Game sync failed, but allowing user to continue with login');
    }
    } catch (syncError: any) {
      // Catch any unexpected errors during game sync (e.g., database connection issues)
      console.error('Unexpected error during game sync:', {
        error: syncError.message,
        stack: syncError.stack,
        steamId,
      });
      // Continue with login even if game sync fails
      console.warn('Game sync encountered an error, but allowing user to continue with login');
    }
  }

  // -----------------------------
  // Redirect User After Successful Operation
  // -----------------------------

  // Generate an absolute URL for redirection to library using the same base URL logic as steam-login
  let baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  
  if (!baseUrl) {
    if (process.env.VERCEL_URL) {
      baseUrl = `https://${process.env.VERCEL_URL}`;
    } else {
      baseUrl = 'http://localhost:3000';
    }
  }
  
  const redirectUrl = `${baseUrl}/library`;

  if (DEBUG) {
    console.log(`Redirecting user to: ${redirectUrl}`);
  }

  // Create a NextResponse redirect
  const nextResponse = NextResponse.redirect(redirectUrl);

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

  if (DEBUG) {
    console.log(`Set 'steamid' cookie and redirecting to: ${redirectUrl}`);
  }

  return nextResponse;
}
