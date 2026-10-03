import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, antiRepeat } = vi.hoisted(() => ({
  auth: vi.fn(),
  antiRepeat: {
    getAntiRepeatDays: vi.fn(),
    setAntiRepeatDays: vi.fn(),
  },
}));

vi.mock('../src/lib/auth', () => ({ getSteamId: auth }));
vi.mock('../src/lib/history/anti-repeat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/history/anti-repeat')>();
  return {
    ...actual,
    getAntiRepeatDays: antiRepeat.getAntiRepeatDays,
    setAntiRepeatDays: antiRepeat.setAntiRepeatDays,
  };
});

import { GET, POST } from '../src/app/api/history/anti-repeat/route';

let userSerial = 0;
let steamId = '76561198000000042';
let serial = 0;
const headers = (extra: Record<string, string> = {}) => ({
  'x-forwarded-for': `198.51.100.${++serial % 250}`,
  ...extra,
});

const get = () =>
  GET(new Request('https://qit.test/api/history/anti-repeat', { headers: headers() }));

const post = (body: unknown, extra: Record<string, string> = { origin: 'https://qit.test' }) =>
  POST(
    new Request('https://qit.test/api/history/anti-repeat', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json', ...extra }),
      body: JSON.stringify(body),
    }),
  );

describe('/api/history/anti-repeat', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.test');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    steamId = `7656119800000${String(1000 + ++userSerial)}`;
    auth.mockResolvedValue(steamId);
    antiRepeat.getAntiRepeatDays.mockResolvedValue(30);
    antiRepeat.setAntiRepeatDays.mockImplementation(async (_id: string, days: number) => days);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('authentication and security guards', () => {
    it('refuses unauthenticated GET requests', async () => {
      auth.mockResolvedValue(null);
      const res = await get();
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: { code: 'unauthenticated', message: 'Authentication required' },
      });
      expect(antiRepeat.getAntiRepeatDays).not.toHaveBeenCalled();
    });

    it('refuses unauthenticated POST requests', async () => {
      auth.mockResolvedValue(null);
      const res = await post({ days: 7 });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error: { code: 'unauthenticated', message: 'Authentication required' },
      });
      expect(antiRepeat.setAntiRepeatDays).not.toHaveBeenCalled();
    });

    it('refuses POST requests with mismatched Origin header', async () => {
      const res = await post({ days: 7 }, { origin: 'https://evil.attacker.com' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: 'forbidden' },
      });
      expect(antiRepeat.setAntiRepeatDays).not.toHaveBeenCalled();
    });

    it('refuses POST requests with missing Origin header', async () => {
      const res = await POST(
        new Request('https://qit.test/api/history/anti-repeat', {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ days: 7 }),
        }),
      );
      expect(res.status).toBe(403);
      expect(antiRepeat.setAntiRepeatDays).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/history/anti-repeat', () => {
    it('returns current anti-repeat setting and available options', async () => {
      antiRepeat.getAntiRepeatDays.mockResolvedValue(90);
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await res.json()).toEqual({
        days: 90,
        options: [0, 7, 30, 90],
        defaultDays: 30,
      });
      expect(antiRepeat.getAntiRepeatDays).toHaveBeenCalledWith(steamId);
    });

    it('returns 502 on backing store failure', async () => {
      antiRepeat.getAntiRepeatDays.mockRejectedValue(new Error('Firestore connection timeout'));
      const res = await get();
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        error: { code: 'unavailable', message: 'Anti-repeat setting is unavailable right now' },
      });
    });

    it('rate limits excessive GET requests', async () => {
      const req = new Request('https://qit.test/api/history/anti-repeat', { headers: { 'x-forwarded-for': '198.51.100.99' } });
      for (let i = 0; i < 30; i++) {
        expect((await GET(req)).status).toBe(200);
      }
      const denied = await GET(req);
      expect(denied.status).toBe(429);
      expect(denied.headers.get('retry-after')).toBeTruthy();
    });
  });

  describe('POST /api/history/anti-repeat', () => {
    it('accepts valid options: 0 (off), 7, 30, and 90', async () => {
      for (const validDays of [0, 7, 30, 90]) {
        antiRepeat.setAntiRepeatDays.mockResolvedValue(validDays);
        const res = await post({ days: validDays });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ days: validDays });
        expect(antiRepeat.setAntiRepeatDays).toHaveBeenCalledWith(steamId, validDays);
      }
    });

    it('rejects invalid days values', async () => {
      for (const invalid of [1, 14, 60, -1, 100, '30', null, undefined, true, {}]) {
        const res = await post({ days: invalid });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          error: { code: 'invalid' },
        });
        expect(antiRepeat.setAntiRepeatDays).not.toHaveBeenCalled();
      }
    });

    it('rejects non-object or malformed JSON bodies', async () => {
      const res = await POST(
        new Request('https://qit.test/api/history/anti-repeat', {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json', origin: 'https://qit.test' }),
          body: 'not a json',
        }),
      );
      expect(res.status).toBe(400);
    });

    it('returns 502 when saving fails', async () => {
      antiRepeat.setAntiRepeatDays.mockRejectedValue(new Error('Write stream error'));
      const res = await post({ days: 7 });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        error: { code: 'unavailable', message: 'Anti-repeat setting could not be saved' },
      });
    });

    it('rate limits repeated POST requests', async () => {
      const req = () =>
        new Request('https://qit.test/api/history/anti-repeat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://qit.test', 'x-forwarded-for': '198.51.100.88' },
          body: JSON.stringify({ days: 30 }),
        });
      for (let i = 0; i < 10; i++) {
        expect((await POST(req())).status).toBe(200);
      }
      const denied = await POST(req());
      expect(denied.status).toBe(429);
      expect(denied.headers.get('retry-after')).toBeTruthy();
    });
  });
});
