import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { ownsGames } from '@/lib/library-data';
import { getCachedAchievementProgress } from '@/lib/achievement-cache';
import { logServerError } from '@/lib/steam';

export async function GET(request: Request) {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const rawAppId = new URL(request.url).searchParams.get('appid');
  const appid = rawAppId && /^\d{1,10}$/.test(rawAppId) ? Number(rawAppId) : NaN;
  if (!Number.isSafeInteger(appid) || appid <= 0) return NextResponse.json({ error: 'Invalid app ID' }, { status: 400 });
  try {
    if (!await ownsGames(steamId, [appid])) return NextResponse.json({ error: 'Game must belong to your library' }, { status: 400 });
    const progress = await getCachedAchievementProgress(steamId, appid);
    return NextResponse.json({ progress });
  } catch (error) {
    logServerError('Achievement lookup failed', error);
    // Achievement availability is optional. Do not make Steam failures turn
    // the otherwise usable picker card into an error state.
    return NextResponse.json({ progress: null });
  }
}
