import { NextResponse } from 'next/server';
import fetch from 'node-fetch';

const STEAM_API_KEY = process.env.STEAM_API_KEY;

// Extract Steam ID from profile URL or validate Steam ID
function extractSteamId(input: string): string | null {
  // Remove whitespace
  const cleaned = input.trim();
  
  // If it's already a numeric Steam ID (17 digits)
  if (/^\d{17}$/.test(cleaned)) {
    return cleaned;
  }
  
  // Try to extract from Steam profile URL
  const urlPatterns = [
    /steamcommunity\.com\/profiles\/(\d+)/,
    /steamcommunity\.com\/id\/([^\/]+)/,
    /steam\.me\/(\d+)/,
  ];
  
  for (const pattern of urlPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      // If it's a numeric ID, return it
      if (/^\d+$/.test(match[1])) {
        return match[1];
      }
      // If it's a vanity URL, we'll need to resolve it
      // For now, return null and handle it in the API call
      return match[1];
    }
  }
  
  return null;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get('q');
    
    if (!query) {
      return NextResponse.json(
        { error: 'Search query is required' },
        { status: 400 }
      );
    }

    if (!STEAM_API_KEY) {
      return NextResponse.json(
        { error: 'Steam API key not configured' },
        { status: 500 }
      );
    }

    const steamIdOrVanity = extractSteamId(query);
    
    if (!steamIdOrVanity) {
      return NextResponse.json(
        { error: 'Invalid Steam ID or profile URL' },
        { status: 400 }
      );
    }

    let steamId = steamIdOrVanity;

    // If it's a vanity URL, resolve it to Steam ID
    if (!/^\d+$/.test(steamIdOrVanity)) {
      const resolveUrl = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_API_KEY}&vanityurl=${encodeURIComponent(steamIdOrVanity)}`;
      const resolveRes = await fetch(resolveUrl);
      
      if (resolveRes.ok) {
        const resolveData = await resolveRes.json();
        if (resolveData.response?.steamid) {
          steamId = resolveData.response.steamid;
        } else {
          return NextResponse.json(
            { error: 'Steam profile not found' },
            { status: 404 }
          );
        }
      } else {
        return NextResponse.json(
          { error: 'Failed to resolve Steam profile' },
          { status: 500 }
        );
      }
    }

    // Fetch user profile
    const profileUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`;
    const profileRes = await fetch(profileUrl);
    
    if (!profileRes.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch Steam profile' },
        { status: 500 }
      );
    }

    const profileData = await profileRes.json();
    const player = profileData.response?.players?.[0];
    
    if (!player) {
      return NextResponse.json(
        { error: 'Steam profile not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      steamId: player.steamid,
      personaName: player.personaname,
      profileUrl: player.profileurl,
      avatarFull: player.avatarfull,
      avatarMedium: player.avatarmedium,
      communityVisibilityState: player.communityvisibilitystate,
      profileState: player.profilestate,
    });
  } catch (error) {
    console.error('Error searching Steam profile:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

