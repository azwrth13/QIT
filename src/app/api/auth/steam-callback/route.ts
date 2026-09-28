import { NextResponse } from 'next/server';
import prisma from '../../../library/prisma';
import { SteamOwnedGamesResponse, SteamProfileResponse } from '@/types/api';
import { baseUrl, logServerError, OPENID_ENDPOINT, steamApiUrl, steamJson, validateOpenId } from '@/lib/steam';
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/session';

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const steamId = validateOpenId(params, `${baseUrl()}/api/auth/steam-callback`);
    if (!steamId) return NextResponse.json({ error: 'Invalid OpenID response' }, { status: 400 });
    const verifyParams = new URLSearchParams();
    for (const [key, value] of params) {
      if (key.startsWith('openid.')) verifyParams.set(key, value);
    }
    verifyParams.set('openid.mode', 'check_authentication');
    const verification = await fetch(OPENID_ENDPOINT, {
      method: 'POST', body: verifyParams, cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    if (!verification.ok) throw new Error('Steam verification failed');
    const body = await verification.text();
    if (!body.split(/\r?\n/).includes('is_valid:true')) {
      return NextResponse.json({ error: 'Invalid login attempt' }, { status: 401 });
    }
    const profileData = await steamJson<SteamProfileResponse>(steamApiUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }));
    const profile = profileData.response.players.find(player => player.steamid === steamId);
    if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    const user = await prisma.user.upsert({
      where: { steamId }, update: { profileUrl: profile.profileurl }, create: { steamId, profileUrl: profile.profileurl },
    });
    const gamesData = await steamJson<SteamOwnedGamesResponse>(steamApiUrl('/IPlayerService/GetOwnedGames/v1/', { steamid: steamId, include_appinfo: 'true' }));
    const games = gamesData.response.games;
    if (games?.length) {
      try {
        const existingGames = await prisma.game.findMany({ where: { userId: user.id } });
        const existingByApp = new Map(existingGames.map(game => [game.appid, game]));
        const appids = new Set(games.map(game => game.appid));
        await prisma.$transaction(async tx => {
          const newGames = games.filter(game => !existingByApp.has(game.appid));
          if (newGames.length) await tx.game.createMany({
            data: newGames.map(game => ({ appid: game.appid, name: game.name, img_icon_url: game.img_icon_url || '', playtime_forever: game.playtime_forever || 0, userId: user.id })),
            skipDuplicates: true,
          });
          for (const game of games) {
            const existing = existingByApp.get(game.appid);
            if (existing && (existing.name !== game.name || existing.img_icon_url !== (game.img_icon_url || '') || existing.playtime_forever !== (game.playtime_forever || 0))) {
              await tx.game.update({ where: { id: existing.id }, data: { name: game.name, img_icon_url: game.img_icon_url || '', playtime_forever: game.playtime_forever || 0 } });
            }
          }
          const removed = existingGames.filter(game => !appids.has(game.appid)).map(game => game.id);
          if (removed.length) await tx.game.deleteMany({ where: { id: { in: removed } } });
        }, { timeout: 60000, isolationLevel: 'ReadCommitted' });
      } catch (error) {
        // Preserve login when library synchronization fails.
        logServerError('Game sync failed', error);
      }
    }
    const response = NextResponse.redirect(`${baseUrl()}/library`);
    response.cookies.set(SESSION_COOKIE, await createSession(steamId), sessionCookieOptions);
    response.cookies.set('steamid', '', { ...sessionCookieOptions, maxAge: 0 });
    return response;
  } catch (error) {
    logServerError('Steam login failed', error);
    return NextResponse.json({ error: 'Unable to complete Steam login' }, { status: 500 });
  }
}
