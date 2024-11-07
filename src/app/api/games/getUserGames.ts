import { NextApiRequest, NextApiResponse } from 'next';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    const { steamId } = req.query;

    if (!steamId) {
        res.status(400).json({ error: 'Steam ID is required' });
        return;
    }

    try {
        // Fetch games for the user with the given steamId
        const userWithGames = await prisma.user.findUnique({
            where: { steamId: steamId as string },
            include: { games: true }, // Include games associated with the user
        });

        if (!userWithGames) {
            res.status(404).json({ error: 'User not found or no games available' });
            return;
        }

        res.status(200).json({ games: userWithGames.games });
    } catch (error) {
        console.error('Error fetching user games:', error);
        res.status(500).json({ error: 'Error fetching user games' });
    }
}
