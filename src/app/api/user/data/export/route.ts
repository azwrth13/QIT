import { getSteamId } from '@/lib/auth';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse } from '@/lib/http/guards';
import { exportUserData } from '@/lib/privacy/data';
import { logServerError } from '@/lib/steam';

const limits = { user: createLimiter({ capacity: 2, refillPerSecond: 1 / 60 }), ip: createLimiter({ capacity: 10, refillPerSecond: 1 / 10 }) };

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  try {
    return jsonResponse(await exportUserData(steamId), 200, {
      'Content-Disposition': `attachment; filename="qit-data-${steamId}.json"`, 'Vary': 'Cookie',
    });
  } catch (error) {
    logServerError('Data export failed', error);
    return errorResponse('unavailable', 'Unable to export your data. Please retry.');
  }
}
