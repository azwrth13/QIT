import prisma from './prisma';
import type { Game } from './games';
import { getSteamGames } from './steam';

export async function getStoredGames(steamId: string): Promise<Game[]> {
  const user = await prisma.user.findUnique({
    where: { steamId },
    select: { games: { select: { appid: true, name: true, img_icon_url: true, playtime_forever: true } } },
  });
  return user?.games || [];
}

export async function syncLibrary(steamId: string, profileUrl: string): Promise<Game[] | null> {
  const games = await getSteamGames(steamId);
  if (games === null) return null;
  const user = await prisma.user.upsert({
    where: { steamId }, update: { profileUrl }, create: { steamId, profileUrl }, select: { id: true },
  });
  await prisma.$transaction(async tx => {
    const existing = await tx.game.findMany({ where: { userId: user.id }, select: { appid: true } });
    const incoming = new Set(games.map(game => game.appid));
    await tx.game.deleteMany({ where: { userId: user.id, appid: { notIn: [...incoming] } } });
    const old = new Set(existing.map(game => game.appid));
    const fresh = games.filter(game => !old.has(game.appid));
    if (fresh.length) await tx.game.createMany({ data: fresh.map(game => ({
      appid: game.appid, name: [...game.name].slice(0, 191).join(''), img_icon_url: game.img_icon_url || '',
      playtime_forever: game.playtime_forever || 0, userId: user.id,
    })) });
    for (const game of games.filter(game => old.has(game.appid))) {
      await tx.game.update({ where: { appid_userId: { appid: game.appid, userId: user.id } }, data: {
        name: [...game.name].slice(0, 191).join(''), img_icon_url: game.img_icon_url || '', playtime_forever: game.playtime_forever || 0,
      } });
    }
  }, { timeout: 60000 });
  return games;
}

export async function ensureUser(steamId: string, profileUrl: string) {
  await prisma.user.upsert({ where: { steamId }, update: { profileUrl }, create: { steamId, profileUrl } });
}
