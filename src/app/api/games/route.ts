// app/api/games/route.ts

import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { logServerError } from '@/lib/steam';
import prisma from '../../library/prisma';

export async function GET() {
  try {
    // Access cookies from the request
    const steamId = await getSteamId();

    if (!steamId) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Fetch user and their games from the database
    const userWithGames = await prisma.user.findUnique({
      where: { steamId },
      include: { games: true },
    });

    if (!userWithGames || !userWithGames.games.length) {
      return NextResponse.json(
        { error: 'User not found or no games available' },
        { status: 404 }
      );
    }

    return NextResponse.json({ games: userWithGames.games });
  } catch (error) {
    logServerError('Error fetching user games', error);
    return NextResponse.json(
      { error: 'Error fetching user games' },
      { status: 500 }
    );
  }
}
