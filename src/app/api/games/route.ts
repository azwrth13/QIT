// app/api/games/route.ts

import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { cookies } from 'next/headers'; // Ensure correct import

const prisma = new PrismaClient();

export async function GET(req: Request) {
  try {
    // Access cookies from the request
    const cookieStore = await cookies(); // No 'await' here
    const steamId = cookieStore.get('steamid')?.value;

    if (!steamId) {
      return NextResponse.json(
        { error: 'Steam ID is required' },
        { status: 400 }
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
    console.error('Error fetching user games:', error);
    return NextResponse.json(
      { error: 'Error fetching user games' },
      { status: 500 }
    );
  }
}
