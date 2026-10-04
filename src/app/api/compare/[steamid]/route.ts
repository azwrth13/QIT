import { compareFailure, compareGuard } from '@/lib/compare/http';
import { compareLibrariesService } from '@/lib/compare/service';
import { errorResponse, jsonResponse } from '@/lib/http/guards';
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

  try {
    const result = await compareLibrariesService(guard.steamId, steamid);
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

  try {
    const result = await compareLibrariesService(guard.steamId, steamid);
    return jsonResponse(result);
  } catch (error) {
    return compareFailure(error);
  }
}
