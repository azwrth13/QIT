import { getSteamId } from '@/lib/auth';
import { checkRateLimit, checkSameOrigin, createLimiter, errorResponse, jsonResponse, readJsonBody } from '@/lib/http/guards';
import { DAILY_REROLL_LIMIT, type DailyAction } from '@/lib/daily/model';
import { actOnDaily, DailyConflict, dailyHistory, DailyInputError, getToday, saveDailySettings } from '@/lib/daily/service';
import { logServerError } from '@/lib/steam';

const limits = { user: createLimiter({ capacity: 20, refillPerSecond: 0.3 }), ip: createLimiter({ capacity: 80, refillPerSecond: 2 }) };
const dateKey = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function failed(error: unknown) {
  if (error instanceof DailyConflict) return jsonResponse({ error: { code: 'conflict', message: error.message } }, 409);
  if (error instanceof DailyInputError) return errorResponse('invalid', error.message);
  logServerError('Daily QIT failed', error);
  return errorResponse('unavailable', 'Daily QIT is unavailable right now');
}

export async function GET(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  if ([...params.keys()].some(key => !['history', 'cursor'].includes(key)) || (params.has('cursor') && !dateKey(params.get('cursor')))
    || (params.has('history') && params.get('history') !== '1') || (params.has('cursor') && !params.has('history'))) {
    return errorResponse('invalid', 'Invalid daily history request');
  }
  try {
    return jsonResponse(params.has('history') ? await dailyHistory(steamId, params.get('cursor') ?? undefined) : await getToday(steamId));
  } catch (error) { return failed(error); }
}

export async function POST(req: Request) {
  const steamId = await getSteamId();
  if (!steamId) return errorResponse('unauthenticated', 'Authentication required');
  const denied = checkSameOrigin(req) ?? checkRateLimit(req, steamId, limits);
  if (denied) return denied;
  const parsed = await readJsonBody(req, 1024);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('invalid', 'Invalid daily action');
  try {
    if (body.action === 'settings') {
      if (Object.keys(body).some(key => !['action', 'settings'].includes(key))) return errorResponse('invalid', 'Invalid daily settings');
      return jsonResponse({ settings: await saveDailySettings(steamId, body.settings) });
    }
    if (!['accept', 'reroll', 'skip', 'played'].includes(body.action as string) || !dateKey(body.date)
      || !Number.isInteger(body.revision) || (body.revision as number) < 0 || (body.revision as number) > DAILY_REROLL_LIMIT
      || Object.keys(body).some(key => !['action', 'date', 'revision'].includes(key))) return errorResponse('invalid', 'Invalid daily action');
    return jsonResponse(await actOnDaily(steamId, body.action as DailyAction, body.date, body.revision as number));
  } catch (error) { return failed(error); }
}
