import { getSteamId } from '../auth';
import { checkRateLimit, createLimiter, errorResponse, jsonResponse } from '../http/guards';
import { logServerError } from '../steam';
import { CompareError } from './types';

export const compareLimits = {
  user: createLimiter({ capacity: 20, refillPerSecond: 1 / 3 }),
  ip: createLimiter({ capacity: 60, refillPerSecond: 1 }),
};

export async function compareGuard(req: Request): Promise<{ steamId: string } | { response: Response }> {
  const steamId = await getSteamId();
  if (!steamId) return { response: errorResponse('unauthenticated', 'Authentication required') };
  const rateDenied = checkRateLimit(req, steamId, compareLimits);
  if (rateDenied) return { response: rateDenied };
  return { steamId };
}

export function compareFailure(error: unknown): Response {
  if (error instanceof CompareError) {
    const errorBody: { code: string; message: string; state?: string } = {
      code: error.code,
      message: error.message,
    };
    if (error.code === 'not_found' || error.code === 'forbidden' || error.code === 'unavailable') {
      errorBody.state = error.code === 'forbidden' ? 'private' : error.code === 'unavailable' ? 'error' : error.code;
    }
    return jsonResponse({ error: errorBody }, error.status);
  }
  logServerError('Compare request failed', error);
  return errorResponse('unavailable', 'Could not compare Steam libraries. Please try again.');
}
