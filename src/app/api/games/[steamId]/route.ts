// app/api/games/[steamId]/route.ts

import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ steamId: string }> }
) {
  const { steamId } = await params; // Awaiting params

  if (!steamId) {
    return NextResponse.json(
      { error: 'Steam ID is required' },
      { status: 400 }
    );
  }

  try {
    const userWithGames = await prisma.user.findUnique({
      where: { steamId },
      include: { games: true },
    });

    if (!userWithGames) {
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
