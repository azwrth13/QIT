import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { auth, stats } = vi.hoisted(() => ({ auth: vi.fn(), stats: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getSteamId: auth }));
vi.mock('../src/lib/profile/read-stats', () => ({ readProfileStats: stats }));
vi.mock('../src/app/profile/ProfileStatsView', () => ({ default: () => <p>Private statistics view</p> }));
import { GET } from '../src/app/api/profile/stats/route';
import ProfilePage from '../src/app/profile/page';
import { navbarItems } from '../src/app/navbar/nav-items';

let serial = 0;
const request = () => new Request('https://qit.test/api/profile/stats?steamId=someone-else', { headers: { 'x-forwarded-for': `192.0.2.${++serial}` } });

describe('private profile statistics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue(`7656119800000${String(1000 + serial)}`);
    stats.mockResolvedValue({ totalGames: 2, gamesDiscovered: 1 });
  });
  it('rejects anonymous API reads without loading statistics and offers sign-in on the page', async () => {
    auth.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(stats).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(await ProfilePage());
    expect(html).toContain('Sign in with Steam');
    expect(html).not.toContain('Private statistics view');
  });
  it('loads only the session owner and returns private uncached JSON', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(stats).toHaveBeenCalledWith(await auth());
    expect(await response.json()).toEqual({ totalGames: 2, gamesDiscovered: 1 });
    expect(renderToStaticMarkup(await ProfilePage())).toContain('Private statistics view');
  });
  it('returns a safe error when the backing store fails', async () => {
    stats.mockRejectedValue(new Error('internal datastore details'));
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'unavailable', message: 'Your QIT stats are unavailable right now' } });
  });
  it('rate limits repeated requests before reading the store', async () => {
    const req = request();
    for (let i = 0; i < 20; i++) expect((await GET(req)).status).toBe(200);
    const response = await GET(req);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(stats).toHaveBeenCalledTimes(20);
  });
  it('shows the enabled profile link only to signed-in users', () => {
    expect(navbarItems(true).some(item => item.id === 'profile')).toBe(true);
    expect(navbarItems(false).some(item => item.id === 'profile')).toBe(false);
  });
});
