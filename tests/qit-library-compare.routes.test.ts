import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompareError } from '../src/lib/compare/types';

const { getSteamId, compareLibrariesService } = vi.hoisted(() => ({
  getSteamId: vi.fn(),
  compareLibrariesService: vi.fn(),
}));

vi.mock('../src/lib/auth', () => ({ getSteamId }));
vi.mock('../src/lib/compare/service', () => ({ compareLibrariesService }));
vi.mock('../src/lib/base-url', () => ({ getBaseUrl: () => 'https://qit.example' }));

import { GET as getCompareDynamic, POST as postCompareDynamic } from '../src/app/api/compare/[steamid]/route';
import { GET as getCompareRoot, POST as postCompareRoot } from '../src/app/api/compare/route';

const me = '76561198000000001';
const friend = '76561198000000002';

const dynamicContext = { params: Promise.resolve({ steamid: friend }) };
const invalidContext = { params: Promise.resolve({ steamid: 'invalid-id' }) };

const mockResult = {
  target: { steamId: friend, personaName: 'Friend', avatarUrl: null, profileUrl: `https://steamcommunity.com/profiles/${friend}` },
  user: { steamId: me, personaName: 'Me' },
  sharedCount: 5,
  both: [],
  onlyMe: [],
  onlyThem: [],
  neitherRecentlyPlayed: [],
  oneNeverPlayed: [],
  playtimeHidden: { me: false, them: false },
  onlyA: [],
  onlyB: [],
};

function req(method = 'GET', path = `/api/compare/${friend}`, origin = 'https://qit.example', body?: unknown) {
  return new Request(`https://qit.example${path}`, {
    method,
    headers: {
      origin,
      'x-forwarded-for': '198.51.100.1, 203.0.113.1',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  getSteamId.mockReset();
  compareLibrariesService.mockReset();
  getSteamId.mockResolvedValue(me);
  compareLibrariesService.mockResolvedValue(mockResult);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/compare/[steamid]', () => {
  it('requires authentication before processing', async () => {
    getSteamId.mockResolvedValue(null);
    const response = await getCompareDynamic(req('GET'), dynamicContext);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required' } });
    expect(compareLibrariesService).not.toHaveBeenCalled();
  });

  it('rejects an invalid Steam ID with 400', async () => {
    const response = await getCompareDynamic(req('GET', '/api/compare/invalid-id'), invalidContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'invalid', message: 'Enter a valid 17-digit Steam ID.' } });
    expect(compareLibrariesService).not.toHaveBeenCalled();
  });

  it('returns 403 when friend profile is private', async () => {
    compareLibrariesService.mockRejectedValue(
      new CompareError('forbidden', 'This friend’s game details are private. Ask them to set Game details to Public in Steam.', 403)
    );
    const response = await getCompareDynamic(req('GET'), dynamicContext);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe('forbidden');
    expect(body.error.state).toBe('private');
  });

  it('returns 404 when friend profile is not found', async () => {
    compareLibrariesService.mockRejectedValue(
      new CompareError('not_found', 'Steam profile not found.', 404)
    );
    const response = await getCompareDynamic(req('GET'), dynamicContext);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.state).toBe('not_found');
  });

  it('returns 502 when upstream Steam service fails', async () => {
    compareLibrariesService.mockRejectedValue(new Error('Steam failure'));
    const response = await getCompareDynamic(req('GET'), dynamicContext);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe('unavailable');
  });

  it('returns 200 with comparison payload and Cache-Control headers', async () => {
    const response = await getCompareDynamic(req('GET'), dynamicContext);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toEqual(mockResult);
    expect(compareLibrariesService).toHaveBeenCalledWith(me, friend, { notRecentlyPlayedDays: undefined });
  });

  it('forwards custom days query parameter', async () => {
    const response = await getCompareDynamic(req('GET', `/api/compare/${friend}?days=60`), dynamicContext);
    expect(response.status).toBe(200);
    expect(compareLibrariesService).toHaveBeenCalledWith(me, friend, { notRecentlyPlayedDays: 60 });
  });
});

describe('POST /api/compare/[steamid]', () => {
  it('requires authentication on POST', async () => {
    getSteamId.mockResolvedValue(null);
    const response = await postCompareDynamic(req('POST'), dynamicContext);
    expect(response.status).toBe(401);
  });

  it('rejects cross-origin POST requests with 403', async () => {
    const response = await postCompareDynamic(req('POST', `/api/compare/${friend}`, 'https://evil.example'), dynamicContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'forbidden', message: 'Cross-origin request rejected' } });
    expect(compareLibrariesService).not.toHaveBeenCalled();
  });

  it('accepts same-origin POST and parses optional body parameters', async () => {
    const response = await postCompareDynamic(
      req('POST', `/api/compare/${friend}`, 'https://qit.example', { notRecentlyPlayedDays: 45 }),
      dynamicContext
    );
    expect(response.status).toBe(200);
    expect(compareLibrariesService).toHaveBeenCalledWith(me, friend, { notRecentlyPlayedDays: 45 });
  });
});

describe('/api/compare query and body fallback route', () => {
  it('GET /api/compare requires steamid query param', async () => {
    const response = await getCompareRoot(req('GET', '/api/compare'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'invalid', message: 'Enter a valid 17-digit Steam ID in the steamid parameter.' },
    });
  });

  it('GET /api/compare?steamid=... returns comparison for valid id', async () => {
    const response = await getCompareRoot(req('GET', `/api/compare?steamid=${friend}`));
    expect(response.status).toBe(200);
    expect(compareLibrariesService).toHaveBeenCalledWith(me, friend, { notRecentlyPlayedDays: undefined });
  });

  it('POST /api/compare rejects cross-origin', async () => {
    const response = await postCompareRoot(req('POST', '/api/compare', 'https://attacker.example', { steamid: friend }));
    expect(response.status).toBe(403);
  });

  it('POST /api/compare accepts valid same-origin request with body', async () => {
    const response = await postCompareRoot(
      req('POST', '/api/compare', 'https://qit.example', { steamid: friend, notRecentlyPlayedDays: 30 })
    );
    expect(response.status).toBe(200);
    expect(compareLibrariesService).toHaveBeenCalledWith(me, friend, { notRecentlyPlayedDays: 30 });
  });
});
