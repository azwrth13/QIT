import { compareFailure, compareGuard } from '@/lib/compare/http';
import { compareLibrariesService } from '@/lib/compare/service';
import { errorResponse, jsonResponse, readJsonBody } from '@/lib/http/guards';
import { isSteamId } from '@/lib/steam';

export const runtime = 'nodejs';

export type CompareRouteContext = { params: Promise<{ steamid: string }> };

export async function GET(req: Request, context: CompareRouteContext) {
  const guard = await compareGuard(req, false);
  if ('response' in guard) return guard.response;

  const { steamid } = await context.params;
  if (!isSteamId(steamid)) {
    return errorResponse('invalid', 'Enter a valid 17-digit Steam ID.');
  }

  const rawDays = new URL(req.url).searchParams.get('days');
  const notRecentlyPlayedDays = rawDays ? Number(rawDays) : undefined;

  try {
    const result = await compareLibrariesService(guard.steamId, steamid, { notRecentlyPlayedDays });
    return jsonResponse(result);
  } catch (error) {
    return compareFailure(error);
  }
}

export async function POST(req: Request, context: CompareRouteContext) {
  const guard = await compareGuard(req, true);
  if ('response' in guard) return guard.response;

  const { steamid } = await context.params;
  if (!isSteamId(steamid)) {
    return errorResponse('invalid', 'Enter a valid 17-digit Steam ID.');
  }

  let notRecentlyPlayedDays: number | undefined;
  if (req.body) {
    const bodyResult = await readJsonBody(req);
    if ('response' in bodyResult) return bodyResult.response;
    if (bodyResult.body && typeof bodyResult.body === 'object' && 'notRecentlyPlayedDays' in bodyResult.body) {
      const days = Number((bodyResult.body as { notRecentlyPlayedDays: unknown }).notRecentlyPlayedDays);
      if (Number.isFinite(days) && days > 0) notRecentlyPlayedDays = days;
    }
  }

  try {
    const result = await compareLibrariesService(guard.steamId, steamid, { notRecentlyPlayedDays });
    return jsonResponse(result);
  } catch (error) {
    return compareFailure(error);
  }
}
