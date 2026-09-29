import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkRateLimit, checkSameOrigin, createLimiter, errorResponse, parseAppId, parseBoundedString, parseSteamId, readJsonBody,
} from '../src/lib/http/guards';

afterEach(() => vi.unstubAllEnvs());

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('https://qit.test/api/x', { method: 'POST', body, headers });

describe('checkSameOrigin', () => {
  it('accepts a matching Origin or Referer and rejects missing or foreign ones', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.test');
    expect(checkSameOrigin(post('{}', { origin: 'https://qit.test' }))).toBeNull();
    expect(checkSameOrigin(post('{}', { referer: 'https://qit.test/library' }))).toBeNull();
    for (const headers of [{} as Record<string, string>, { origin: 'https://evil.test' }, { origin: 'null' }, { origin: 'nonsense' }]) {
      const res = checkSameOrigin(post('{}', headers));
      expect(res?.status).toBe(403);
      expect(await res?.json()).toEqual({ error: { code: 'forbidden', message: 'Cross-origin request rejected' } });
    }
  });
});

describe('createLimiter', () => {
  it('spends tokens, reports wait time, and refills', () => {
    const limiter = createLimiter({ capacity: 2, refillPerSecond: 1 });
    expect(limiter.take('a', 0)).toBe(0);
    expect(limiter.take('a', 0)).toBe(0);
    expect(limiter.take('a', 0)).toBe(1);
    expect(limiter.take('b', 0)).toBe(0);
    expect(limiter.take('a', 1000)).toBe(0);
  });
  it('bounds memory', () => {
    const limiter = createLimiter({ capacity: 1, refillPerSecond: 1 });
    for (let i = 0; i < 6000; i++) limiter.take(`k${i}`, i);
    expect(limiter.size()).toBeLessThanOrEqual(5000);
  });
  it('checkRateLimit applies per-user and per-IP buckets with Retry-After', async () => {
    const limits = { user: createLimiter({ capacity: 1, refillPerSecond: 0.5 }), ip: createLimiter({ capacity: 3, refillPerSecond: 0.5 }) };
    const req = new Request('https://qit.test', { headers: { 'x-forwarded-for': '203.0.113.1, 35.191.0.1' } });
    expect(checkRateLimit(req, '1', limits, 0)).toBeNull();
    const res = checkRateLimit(req, '1', limits, 0);
    expect(res?.status).toBe(429);
    expect(res?.headers.get('retry-after')).toBe('2');
    expect(checkRateLimit(req, '2', limits, 0)).toBeNull();
    expect(checkRateLimit(req, '3', limits, 0)?.status).toBe(429);
  });
});

describe('readJsonBody', () => {
  it('parses JSON under the cap', async () => {
    expect(await readJsonBody(post('{"a":1}'))).toEqual({ body: { a: 1 } });
  });
  it('rejects oversized bodies whether or not Content-Length is honest', async () => {
    const big = JSON.stringify({ s: 'x'.repeat(100) });
    const declared = await readJsonBody(post(big, { 'content-length': String(big.length) }), 50);
    expect('response' in declared && declared.response.status).toBe(413);
    const streamed = await readJsonBody(post(big, { 'content-length': '1' }), 50);
    expect('response' in streamed && streamed.response.status).toBe(413);
  });
  it('rejects malformed JSON and invalid UTF-8 with 400', async () => {
    for (const body of ['{nope', new Uint8Array([0x7b, 0xff, 0x7d])]) {
      const result = await readJsonBody(post(body));
      expect('response' in result && result.response.status).toBe(400);
    }
  });
});

describe('errorResponse and validators', () => {
  it('uses a uniform no-store envelope', async () => {
    const res = errorResponse('unauthenticated', 'Authentication required');
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required' } });
  });
  it('validates ids and strings', () => {
    expect(parseSteamId('76561198000000000')).toBe('76561198000000000');
    expect(parseSteamId('123')).toBeNull();
    expect(parseAppId(730)).toBe(730);
    for (const bad of [0, -1, 1.5, '730', NaN, 2 ** 60]) expect(parseAppId(bad)).toBeNull();
    expect(parseBoundedString('abc', 5)).toBe('abc');
    for (const bad of ['', '  ', 'abcdef', 5]) expect(parseBoundedString(bad, 5)).toBeNull();
  });
});
