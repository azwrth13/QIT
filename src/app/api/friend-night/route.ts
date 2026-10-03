import { getSteamId } from '@/lib/auth';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, parseSteamId, readJsonBody } from '@/lib/http/guards';
import { DISCOVERY, type Discovery } from '@/lib/friend-night/model';
import { friendNight } from '@/lib/friend-night/service';
import { SpinInputError } from '@/lib/roulette/pipeline';
import { parseSpinRequest, SPIN_MAX_BODY_BYTES } from '@/lib/roulette/request';
import { SOURCED_FAMILIES } from '@/lib/roulette/service';
import { getLibraryFor } from '@/lib/social/libraries';
import { logServerError } from '@/lib/steam';

const limits = { user: createLimiter({ capacity: 30, refillPerSecond: 0.5 }), ip: createLimiter({ capacity: 90, refillPerSecond: 1 }) };
const spins = { user: createLimiter({ capacity: 10, refillPerSecond: 0.2 }), ip: createLimiter({ capacity: 40, refillPerSecond: 1 }) };
export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  const parsed = await readJsonBody(req, SPIN_MAX_BODY_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('invalid', 'Invalid Friend Night request');
  const { action, discovery = 'any', hours = 10, ...input } = body as Record<string, unknown>;
  try {
    if (action === 'library') {
      const id = parseSteamId(input.steamId);
      if (!id || id === steamId || Object.keys(input).length !== 1 || discovery !== 'any' || hours !== 10) return errorResponse('invalid', 'Select another Steam player');
      const [library] = await getLibraryFor([id]);
      return jsonResponse({ steamId: id, state: library.state, count: library.state === 'ok' ? library.games.size : null });
    }
    if ((action !== 'pool' && action !== 'spin') || !DISCOVERY.includes(discovery as Discovery)
      || typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 100000) return errorResponse('invalid', 'Invalid discovery filter');
    if (action === 'spin') { const limited = checkRateLimit(req, steamId, spins); if (limited) return limited; }
    const spin = parseSpinRequest(input, action, SOURCED_FAMILIES);
    if (!spin.ok) return errorResponse('invalid', spin.error);
    if (spin.request.scope.kind !== 'friends' || spin.request.scope.with.includes(steamId)) return errorResponse('invalid', 'Select one or more other players');
    return jsonResponse(await friendNight(steamId, spin.request, action, discovery as Discovery, hours));
  } catch (error) {
    if (error instanceof SpinInputError) return errorResponse('invalid', error.message);
    logServerError('Friend Night failed', error);
    return errorResponse('unavailable', 'Friend Night is unavailable. Please try again.');
  }
}
