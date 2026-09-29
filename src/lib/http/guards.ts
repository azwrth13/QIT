import { getBaseUrl } from '../base-url';
import { clientIpFromForwardedFor } from '../client-ip';
import { isSteamId, makeRoom } from '../steam';

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024;
export const NO_STORE = 'private, no-store';
const BUCKET_LIMIT = 5000;

export type ErrorCode = 'unauthenticated' | 'forbidden' | 'invalid' | 'too_large' | 'rate_limited' | 'unavailable';
const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401, forbidden: 403, invalid: 400, too_large: 413, rate_limited: 429, unavailable: 502,
};

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': NO_STORE, ...headers } });
}

export function errorResponse(code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error: { code, message } }, STATUS[code], headers);
}

/** Rejects cross-site POSTs. Requires an Origin (or, failing that, Referer) matching the configured base URL. */
export function checkSameOrigin(req: Request): Response | null {
  const source = req.headers.get('origin') ?? req.headers.get('referer');
  let ok = false;
  try { ok = !!source && new URL(source).origin === getBaseUrl(req); } catch { ok = false; }
  return ok ? null : errorResponse('forbidden', 'Cross-origin request rejected');
}

type Bucket = { tokens: number; updatedAt: number };
export type LimiterOptions = { capacity: number; refillPerSecond: number };

/** Token bucket keyed by string. State is per server instance, so limits are approximate across instances. */
export function createLimiter({ capacity, refillPerSecond }: LimiterOptions) {
  const buckets = new Map<string, Bucket>();
  return {
    /** Returns 0 when allowed, otherwise the seconds to wait before retrying. */
    take(key: string, now = Date.now()): number {
      const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
      bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) / 1000 * refillPerSecond);
      bucket.updatedAt = now;
      if (!buckets.has(key)) {
        makeRoom(buckets, value => value.updatedAt + (capacity - value.tokens) / refillPerSecond * 1000, now, BUCKET_LIMIT);
        buckets.set(key, bucket);
      }
      if (bucket.tokens >= 1) { bucket.tokens -= 1; return 0; }
      return Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond));
    },
    size: () => buckets.size,
  };
}

export type Limiter = ReturnType<typeof createLimiter>;

/** Applies a per-user and a per-IP bucket. Returns a 429 response, or null when allowed. */
export function checkRateLimit(req: Request, steamId: string, limits: { user: Limiter; ip: Limiter }, now = Date.now()): Response | null {
  const wait = Math.max(limits.user.take(`u:${steamId}`, now), limits.ip.take(`i:${clientIpFromForwardedFor(req.headers)}`, now));
  return wait ? errorResponse('rate_limited', 'Too many requests', { 'Retry-After': String(wait) }) : null;
}

/** Reads a JSON body under a byte cap, without trusting Content-Length alone. */
export async function readJsonBody(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<{ body: unknown } | { response: Response }> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { response: errorResponse('too_large', 'Request body too large') };
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); return { response: errorResponse('too_large', 'Request body too large') }; }
      chunks.push(value);
    }
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return { body: JSON.parse(text) };
  } catch {
    return { response: errorResponse('invalid', 'Invalid request body') };
  }
}

export function parseSteamId(value: unknown): string | null {
  return isSteamId(value) ? value : null;
}

export function parseAppId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseBoundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : null;
}
