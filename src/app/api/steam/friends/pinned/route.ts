import { getSteamId } from '@/lib/auth';
import {
  checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, parseBoundedString, parseSteamId, readJsonBody,
} from '@/lib/http/guards';
import { MAX_PIN_INPUT_LENGTH, MAX_PINNED, pinPlayer, unpinPlayer, type PinFailure } from '@/lib/social/pinned';
import { logServerError } from '@/lib/steam';

// Pinned players stand in for a private friends list (D11). Adding one costs up to two Steam calls, so both
// methods share a small per-user and per-IP budget.
const limits = {
  user: createLimiter({ capacity: 10, refillPerSecond: 10 / 60 }),
  ip: createLimiter({ capacity: 30, refillPerSecond: 30 / 60 }),
};

const FAILURES: Record<PinFailure, string> = {
  invalid: 'Enter a Steam profile URL, a 17-digit Steam ID or a custom profile name.',
  not_found: 'Steam profile not found.',
  self: 'That is your own profile.',
  limit: `You can pin up to ${MAX_PINNED} players. Remove one first.`,
};

async function guarded(req: Request): Promise<{ steamId: string } | { response: Response }> {
  const steamId = await getSteamId();
  if (!steamId) return { response: errorResponse('unauthenticated', 'Authentication required') };
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  return denied ? { response: denied } : { steamId };
}

export async function POST(req: Request) {
  const guard = await guarded(req);
  if ('response' in guard) return guard.response;
  const parsed = await readJsonBody(req);
  if ('response' in parsed) return parsed.response;
  const player = parsed.body && typeof parsed.body === 'object' ? parseBoundedString((parsed.body as { player?: unknown }).player, MAX_PIN_INPUT_LENGTH) : null;
  if (!player) return errorResponse('invalid', FAILURES.invalid);
  try {
    const result = await pinPlayer(guard.steamId, player);
    return result.ok ? jsonResponse({ player: result.player, pinned: result.pinned }) : errorResponse('invalid', FAILURES[result.reason]);
  } catch (error) {
    logServerError('Pinning a player failed', error);
    return errorResponse('unavailable', 'Could not pin this player. Please try again.');
  }
}

export async function DELETE(req: Request) {
  const guard = await guarded(req);
  if ('response' in guard) return guard.response;
  const target = parseSteamId(new URL(req.url).searchParams.get('steamid'));
  if (!target) return errorResponse('invalid', 'Enter a valid Steam ID.');
  try {
    return jsonResponse({ pinned: await unpinPlayer(guard.steamId, target) });
  } catch (error) {
    logServerError('Unpinning a player failed', error);
    return errorResponse('unavailable', 'Could not unpin this player. Please try again.');
  }
}
