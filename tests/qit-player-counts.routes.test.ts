import { beforeEach, describe, expect, it, vi } from 'vitest';
const { getSteamId, ownsGames, getCurrentPlayers } = vi.hoisted(() => ({ getSteamId: vi.fn(), ownsGames: vi.fn(), getCurrentPlayers: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getSteamId }));
vi.mock('../src/lib/library', () => ({ ownsGames }));
vi.mock('../src/lib/apps/live-players', async original => ({ ...await original<typeof import('../src/lib/apps/live-players')>(), getCurrentPlayers }));
vi.mock('../src/lib/store/app-live', () => ({}));
vi.mock('../src/lib/base-url', () => ({ getBaseUrl: () => 'https://qit.example' }));
import { POST } from '../src/app/api/apps/players/route';
let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks(); sequence++;
  getSteamId.mockResolvedValue(`76561198000${String(10000 + sequence)}`);
  ownsGames.mockResolvedValue(true);
  getCurrentPlayers.mockResolvedValue({ players: new Map([[10, 500], [20, null]]), unresolved: [30], fetched: 2 });
});
const request = (body: unknown, origin = 'https://qit.example') => new Request('https://qit.example/api/apps/players', {
  method: 'POST', headers: { origin, 'x-forwarded-for': `203.0.113.${sequence}` }, body: JSON.stringify(body),
});
describe('POST /api/apps/players', () => {
  it('requires authentication before reading ownership or counters', async () => {
    getSteamId.mockResolvedValue(null);
    expect((await POST(request({ appids: [10] }))).status).toBe(401);
    expect(ownsGames).not.toHaveBeenCalled(); expect(getCurrentPlayers).not.toHaveBeenCalled();
  });
  it('rejects a cross-origin request', async () => {
    expect((await POST(request({ appids: [10] }, 'https://evil.example'))).status).toBe(403);
    expect(ownsGames).not.toHaveBeenCalled();
  });
  it('refuses the whole batch if any app is not owned', async () => {
    ownsGames.mockResolvedValue(false);
    expect((await POST(request({ appids: [10, 20] }))).status).toBe(403);
    expect(getCurrentPlayers).not.toHaveBeenCalled();
  });
  it('refuses more than 40 submitted ids, including duplicates, before ownership reads', async () => {
    expect((await POST(request({ appids: Array(41).fill(10) }))).status).toBe(400);
    expect(ownsGames).not.toHaveBeenCalled(); expect(getCurrentPlayers).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { appids: '10' }, { appids: [0] }, { appids: ['10'] }, { appids: [1.5] }, { appids: [10000000000] }])('rejects invalid input %j', async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(ownsGames).not.toHaveBeenCalled();
  });
  it('accepts 40 owned ids and returns pool bands, unknown counters and unresolved failures', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    const response = await POST(request({ appids: ids }));
    expect(response.status).toBe(200);
    expect(ownsGames).toHaveBeenCalledWith(await getSteamId(), ids);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ players: { 10: { players: 500, band: 'high' }, 20: { players: null, band: null } }, unresolved: [30], fetched: 2 });
  });
  it('deduplicates ids before ownership and fetch', async () => {
    await POST(request({ appids: [10, 10] }));
    expect(getCurrentPlayers).toHaveBeenCalledWith([10]);
    expect(ownsGames).toHaveBeenCalledWith(await getSteamId(), [10]);
  });
  it('rate limits repeated requests per user', async () => {
    for (let i = 0; i < 20; i++) expect((await POST(request({ appids: [10] }))).status).toBe(200);
    const response = await POST(request({ appids: [10] }));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(getCurrentPlayers).toHaveBeenCalledTimes(20);
  });
  it('uses safe logging and a plain error envelope on storage failure', async () => {
    ownsGames.mockRejectedValue(new Error('secret URL'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await POST(request({ appids: [10] }));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
    expect(log).toHaveBeenCalledWith('Player counts failed', { name: 'Error' });
    log.mockRestore();
  });
});
