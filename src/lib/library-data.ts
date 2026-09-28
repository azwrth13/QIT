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
    const existing = await tx.game.findMany({
      where: { userId: user.id }, select: { appid: true, name: true, img_icon_url: true, playtime_forever: true },
    });
    const incoming = new Set(games.map(game => game.appid));
    await tx.game.deleteMany({ where: { userId: user.id, appid: { notIn: [...incoming] } } });
    const old = new Map(existing.map(game => [game.appid, game]));
    const rows = games.map(game => ({
      appid: game.appid, name: [...game.name].slice(0, 191).join(''), img_icon_url: game.img_icon_url || '',
      playtime_forever: game.playtime_forever || 0,
    }));
    const fresh = rows.filter(game => !old.has(game.appid));
    if (fresh.length) await tx.game.createMany({ data: fresh.map(game => ({ ...game, userId: user.id })) });
    const changed = rows.filter(game => {
      const stored = old.get(game.appid);
      return stored && (stored.name !== game.name || stored.img_icon_url !== game.img_icon_url || stored.playtime_forever !== game.playtime_forever);
    });
    for (const { appid, ...data } of changed) {
      await tx.game.update({ where: { appid_userId: { appid, userId: user.id } }, data });
    }
  }, { timeout: 60000 });
  return games;
}

export async function ensureUser(steamId: string, profileUrl: string) {
  await prisma.user.upsert({ where: { steamId }, update: { profileUrl }, create: { steamId, profileUrl } });
}
