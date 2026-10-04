import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, overview, spin } = vi.hoisted(() => ({
  auth: vi.fn(),
  overview: vi.fn(),
  spin: vi.fn(),
}));

vi.mock('../src/lib/auth', () => ({ getSteamId: auth }));
vi.mock('../src/lib/backlog/service', () => ({
  getBacklogOverview: overview,
  spinBacklog: spin,
}));

import { GET } from '../src/app/api/backlog/route';
import { POST } from '../src/app/api/backlog/spin/route';
import { isNavEnabled, navbarItems } from '../src/app/navbar/nav-items';

let serial = 0;
const getReq = () =>
  new Request('https://qit.test/api/backlog', {
    headers: { 'x-forwarded-for': `192.0.2.${++serial}` },
  });

const postReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://qit.test/api/backlog/spin', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://qit.test',
      'x-forwarded-for': `192.0.2.${++serial}`,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('backlog overview route GET /api/backlog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue(`7656119800000${String(1000 + serial)}`);
    overview.mockResolvedValue({ totalGames: 5, scannedGames: 5, categories: {} });
  });

  it('rejects anonymous API reads with 401 unauthenticated', async () => {
    auth.mockResolvedValue(null);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(overview).not.toHaveBeenCalled();
  });

  it('returns private uncached JSON on success', async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(overview).toHaveBeenCalledWith(await auth(), { sessionId: undefined });
    expect(await res.json()).toEqual({ totalGames: 5, scannedGames: 5, categories: {} });
  });

  it('passes sessionId to overview service when query param is present', async () => {
    const req = new Request('https://qit.test/api/backlog?sessionId=session_123', {
      headers: { 'x-forwarded-for': `192.0.2.${++serial}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(overview).toHaveBeenCalledWith(await auth(), { sessionId: 'session_123' });
  });

  it('rejects invalid sessionId query param with 400', async () => {
    const req = new Request('https://qit.test/api/backlog?sessionId=invalid%20session%20id%20!!', {
      headers: { 'x-forwarded-for': `192.0.2.${++serial}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid' } });
  });

  it('returns a safe 502 error when service throws', async () => {
    overview.mockRejectedValue(new Error('internal db failure'));
    const res = await GET(getReq());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'unavailable', message: 'Your backlog is unavailable right now' },
    });
  });

  it('rate limits repeated requests before reading the store', async () => {
    const req = getReq();
    for (let i = 0; i < 30; i++) {
      expect((await GET(req)).status).toBe(200);
    }
    const res = await GET(req);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('backlog spin route POST /api/backlog/spin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue(`7656119800000${String(1000 + serial)}`);
    spin.mockResolvedValue({ card: { appid: 620, name: 'Portal 2' }, poolSize: 1, category: 'never-played' });
  });

  it('rejects anonymous spin requests with 401', async () => {
    auth.mockResolvedValue(null);
    const res = await POST(postReq({ category: 'never-played' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(spin).not.toHaveBeenCalled();
  });

  it('rejects cross-origin requests with 403 forbidden', async () => {
    const res = await POST(postReq({ category: 'never-played' }, { origin: 'https://evil.com' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(spin).not.toHaveBeenCalled();
  });

  it('rejects missing or unknown category with 400 invalid', async () => {
    const res1 = await POST(postReq({}));
    expect(res1.status).toBe(400);
    expect(await res1.json()).toMatchObject({ error: { code: 'invalid' } });

    const res2 = await POST(postReq({ category: 'unknown-cat' }));
    expect(res2.status).toBe(400);
    expect(await res2.json()).toMatchObject({ error: { code: 'invalid' } });
  });

  it('rejects malformed exclude or sessionId parameters with 400', async () => {
    const res1 = await POST(postReq({ category: 'never-played', exclude: ['not-a-number'] }));
    expect(res1.status).toBe(400);

    const res2 = await POST(postReq({ category: 'never-played', sessionId: 'invalid/slash' }));
    expect(res2.status).toBe(400);
  });

  it('executes valid spin and returns private uncached JSON', async () => {
    const res = await POST(postReq({ category: 'never-played', exclude: [100] }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(spin).toHaveBeenCalledWith(await auth(), {
      category: 'never-played',
      exclude: [100],
      sessionId: undefined,
      seed: undefined,
    });
    expect(await res.json()).toEqual({
      card: { appid: 620, name: 'Portal 2' },
      poolSize: 1,
      category: 'never-played',
    });
  });

  it('returns safe 502 error when service throws', async () => {
    spin.mockRejectedValue(new Error('internal failure'));
    const res = await POST(postReq({ category: 'never-played' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'unavailable', message: 'Backlog spin is unavailable right now' },
    });
  });

  it('rate limits repeated spin requests', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await POST(postReq({ category: 'never-played' }))).status).toBe(200);
    }
    const res = await POST(postReq({ category: 'never-played' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('backlog navigation registration', () => {
  it('has backlog enabled in nav-items.ts', () => {
    expect(isNavEnabled('backlog')).toBe(true);
  });

  it('shows backlog in navbar only to signed-in users', () => {
    expect(navbarItems(true).some(item => item.id === 'backlog')).toBe(true);
    expect(navbarItems(false).some(item => item.id === 'backlog')).toBe(false);
  });
});
