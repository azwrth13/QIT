import { compareFailure, compareGuard } from '@/lib/compare/http';
import { compareLibrariesService } from '@/lib/compare/service';
import { errorResponse, jsonResponse, readJsonBody } from '@/lib/http/guards';
import { isSteamId } from '@/lib/steam';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const guard = await compareGuard(req, false);
  if ('response' in guard) return guard.response;

  const url = new URL(req.url);
  const steamid = url.searchParams.get('steamid') ?? url.searchParams.get('steamId');
  if (!steamid || !isSteamId(steamid)) {
    return errorResponse('invalid', 'Enter a valid 17-digit Steam ID in the steamid parameter.');
  }

  const rawDays = url.searchParams.get('days');
  const notRecentlyPlayedDays = rawDays ? Number(rawDays) : undefined;

  try {
    const result = await compareLibrariesService(guard.steamId, steamid, { notRecentlyPlayedDays });
    return jsonResponse(result);
  } catch (error) {
    return compareFailure(error);
  }
}

export async function POST(req: Request) {
  const guard = await compareGuard(req, true);
  if ('response' in guard) return guard.response;

  let steamid: string | null = null;
  let notRecentlyPlayedDays: number | undefined;

  const url = new URL(req.url);
  steamid = url.searchParams.get('steamid') ?? url.searchParams.get('steamId');

  if (req.body) {
    const bodyResult = await readJsonBody(req);
    if ('response' in bodyResult) return bodyResult.response;
    if (bodyResult.body && typeof bodyResult.body === 'object') {
      const b = bodyResult.body as Record<string, unknown>;
      if (typeof b.steamid === 'string') steamid = b.steamid;
      else if (typeof b.steamId === 'string') steamid = b.steamId;
      if (typeof b.notRecentlyPlayedDays === 'number' && b.notRecentlyPlayedDays > 0) {
        notRecentlyPlayedDays = b.notRecentlyPlayedDays;
      }
    }
  }

  if (!steamid || !isSteamId(steamid)) {
    return errorResponse('invalid', 'Enter a valid 17-digit Steam ID.');
  }

  try {
    const result = await compareLibrariesService(guard.steamId, steamid, { notRecentlyPlayedDays });
    return jsonResponse(result);
  } catch (error) {
    return compareFailure(error);
  }
}
