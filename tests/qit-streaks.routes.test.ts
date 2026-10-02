import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { auth, save, stats } = vi.hoisted(() => ({ auth: vi.fn(), save: vi.fn(), stats: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getSteamId: auth }));
vi.mock('../src/lib/profile/timezone', () => ({ setProfileTimeZone: save }));
vi.mock('../src/lib/history/stats', () => ({ readStats: stats }));
vi.mock('../src/lib/library-data', () => ({ getStoredProfile: vi.fn() }));
import { PATCH } from '../src/app/api/user/profile/route';
import { GET } from '../src/app/api/user/stats/route';

let serial = 0;
const request = (body: unknown, origin = 'https://qit.test') => new Request('https://qit.test/api/user/profile', {
  method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('profile timezone and personal stats routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.test');
    auth.mockResolvedValue(`7656119800000${String(1000 + serial++)}`);
    save.mockResolvedValue('America/Los_Angeles');
    stats.mockResolvedValue({ progression: { current: 2 } });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('requires authentication', async () => {
    auth.mockResolvedValue(null);
    expect((await PATCH(request({ tz: 'UTC' }))).status).toBe(401);
    expect((await GET(new Request('https://qit.test/api/user/stats'))).status).toBe(401);
    expect(save).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
  });
  it('rejects foreign origins and malformed settings before writing', async () => {
    expect((await PATCH(request({ tz: 'UTC' }, 'https://evil.test'))).status).toBe(403);
    for (const body of [null, {}, { tz: 'No/Zone' }, { tz: 42 }]) {
      expect((await PATCH(request(body))).status).toBe(400);
    }
    expect(save).not.toHaveBeenCalled();
  });
  it('saves only the session user setting with private responses', async () => {
    const response = await PATCH(request({ tz: 'America/Los_Angeles', steamId: 'someone-else' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(save).toHaveBeenCalledWith(await auth(), 'America/Los_Angeles');
    expect(await response.json()).toEqual({ tz: 'America/Los_Angeles' });
  });
  it('returns only the authenticated user stats', async () => {
    const response = await GET(new Request('https://qit.test/api/user/stats?steamId=someone-else'));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(stats).toHaveBeenCalledWith(await auth());
    expect(await response.json()).toEqual({ progression: { current: 2 } });
  });
});
