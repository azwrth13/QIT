import { beforeEach, describe, expect, it, vi } from 'vitest';
const { auth, friends, shared, recent } = vi.hoisted(() => ({ auth: vi.fn(), friends: vi.fn(), shared: vi.fn(), recent: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getSteamId: auth }));
vi.mock('../src/lib/social/friends', () => ({ getFriends: friends }));
vi.mock('../src/lib/social/dashboard', () => ({ getSharedDetails: shared }));
vi.mock('../src/lib/social/recent', () => ({ getRecentDetails: recent }));
vi.mock('../src/lib/base-url', () => ({ getBaseUrl: () => 'https://qit.example' }));
import { POST } from '../src/app/api/steam/friends/details/route';
const player = '76561198000000002';
let sequence = 0;
const req = (body: unknown = { steamId: player, kind: 'shared' }, origin: string | null = 'https://qit.example') => new Request('https://qit.example/api/steam/friends/details', {
  method: 'POST', headers: { ...(origin ? { origin } : {}), 'x-forwarded-for': `203.0.113.${sequence}` }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks(); sequence++;
  auth.mockResolvedValue(`76561198000000${String(sequence).padStart(3, '0')}`);
  friends.mockResolvedValue({ source: 'friends', friends: [{ steamId: player }] });
  shared.mockResolvedValue({ state: 'ok', count: 4 });
  recent.mockResolvedValue({ state: 'ok', games: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
describe('POST dashboard details', () => {
  it('requires authentication and same origin before any data read', async () => {
    auth.mockResolvedValueOnce(null);
    expect((await POST(req())).status).toBe(401);
    expect((await POST(req(undefined, 'https://evil.example'))).status).toBe(403);
    expect((await POST(req(undefined, null))).status).toBe(403);
    expect(friends).not.toHaveBeenCalled(); expect(shared).not.toHaveBeenCalled();
  });
  it.each([null, {}, { steamId: 'bad', kind: 'shared' }, { steamId: player, kind: 'all' }, { steamId: player, kind: 'shared', includeGames: 'true' }])('validates the bounded single-player request %j', async body => {
    expect((await POST(req(body))).status).toBe(400);
    expect(friends).not.toHaveBeenCalled();
  });
  it('rejects arbitrary players before loading any Steam data', async () => {
    friends.mockResolvedValue({ source: 'friends', friends: [] });
    expect((await POST(req())).status).toBe(403);
    expect(shared).not.toHaveBeenCalled(); expect(recent).not.toHaveBeenCalled();
  });
  it.each(['friends', 'pinned'])('accepts accessible %s and returns private no-store data', async source => {
    friends.mockResolvedValue({ source, friends: [{ steamId: player }] });
    const response = await POST(req({ steamId: player, kind: 'shared', includeGames: true }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ state: 'ok', count: 4 });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(shared).toHaveBeenCalledWith(await auth(), player, true); expect(recent).not.toHaveBeenCalled();
  });
  it('loads recent games alone on expansion', async () => {
    await POST(req({ steamId: player, kind: 'recent' }));
    expect(recent).toHaveBeenCalledWith(player); expect(shared).not.toHaveBeenCalled();
  });
  it('returns a plain private-games state rather than a zero count', async () => {
    shared.mockResolvedValue({ state: 'private', message: 'Steam game details are private.' });
    expect(await (await POST(req())).json()).toEqual({ state: 'private', message: 'Steam game details are private.' });
  });
  it('returns a guarded error if data lookup fails', async () => {
    shared.mockRejectedValue(new Error('secret'));
    const response = await POST(req());
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).not.toContain('secret');
  });
  it('limits each requester, across shared and recent lookups', async () => {
    vi.useFakeTimers();
    try {
      for (let n = 0; n < 30; n++) expect((await POST(req({ steamId: player, kind: n % 2 ? 'shared' : 'recent' }))).status).toBe(200);
      const response = await POST(req());
      expect(response.status).toBe(429); expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(shared.mock.calls.length + recent.mock.calls.length).toBe(30);
      auth.mockResolvedValue('76561198000000999');
      expect((await POST(req())).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });
});
