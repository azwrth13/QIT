import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { auth, today, history, act, save, log } = vi.hoisted(() => ({ auth: vi.fn(), today: vi.fn(), history: vi.fn(), act: vi.fn(), save: vi.fn(), log: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getSteamId: auth }));
vi.mock('../src/lib/daily/service', async original => {
  const actual = await original<typeof import('../src/lib/daily/service')>();
  return { ...actual, getToday: today, dailyHistory: history, actOnDaily: act, saveDailySettings: save };
});
vi.mock('../src/lib/steam', async original => ({ ...await original<typeof import('../src/lib/steam')>(), logServerError: log }));
import { GET, POST } from '../src/app/api/daily/route';
import { DailyConflict, DailyInputError } from '../src/lib/daily/service';
import DailyPage from '../src/app/daily/page';
const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect }));
let serial = 0;
const post = (body: unknown, origin: string | null = 'https://qit.test') => new Request('https://qit.test/api/daily', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
});
const action = { action: 'accept', date: '2026-10-03', revision: 0 };

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.test');
  auth.mockResolvedValue(`7656119800${String(1000000 + serial++)}`);
  today.mockResolvedValue({ today: { date: action.date } }); history.mockResolvedValue({ dailies: [], nextCursor: null });
  act.mockResolvedValue({ today: { status: 'accepted' } }); save.mockResolvedValue({ mode: 'pure-random', antiRepeatDays: 7 });
});
afterEach(() => vi.unstubAllEnvs());

describe('Daily API and page guards', () => {
  it('requires a session for reads and every mutation', async () => {
    auth.mockResolvedValue(null);
    expect((await GET(new Request('https://qit.test/api/daily'))).status).toBe(401);
    for (const name of ['accept', 'reroll', 'skip', 'played', 'settings']) expect((await POST(post({ ...action, action: name }))).status).toBe(401);
    expect(today).not.toHaveBeenCalled(); expect(act).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('redirects a signed-out page visitor back to Daily after login', async () => {
    auth.mockResolvedValue(null); redirect.mockImplementation(() => { throw new Error('redirect'); });
    await expect(DailyPage()).rejects.toThrow('redirect');
    expect(redirect).toHaveBeenCalledWith('/api/auth/steam-login?next=/daily');
  });
  it('refuses foreign or missing Origin on every POST action before work', async () => {
    for (const name of ['accept', 'reroll', 'skip', 'played', 'settings']) {
      for (const origin of ['https://evil.test', null]) expect((await POST(post({ ...action, action: name }, origin))).status).toBe(403);
    }
    expect(act).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('validates shape, date, revision, unknown keys and oversized/malformed JSON', async () => {
    for (const body of [null, [], {}, { ...action, action: 'delete' }, { ...action, date: '2026-02-30' },
      { ...action, revision: -1 }, { ...action, revision: 4 }, { ...action, revision: 0.5 }, { ...action, steamId: 'other' }]) {
      expect((await POST(post(body))).status).toBe(400);
    }
    expect((await POST(post({ padding: 'x'.repeat(2000) }))).status).toBe(413);
    const malformed = new Request('https://qit.test/api/daily', { method: 'POST', headers: { origin: 'https://qit.test' }, body: '{' });
    expect((await POST(malformed)).status).toBe(400); expect(act).not.toHaveBeenCalled();
  });
  it('uses only the authenticated identity and returns private uncached results', async () => {
    const response = await POST(post(action));
    expect(act).toHaveBeenCalledWith(await auth(), 'accept', action.date, 0);
    expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.status).toBe(200);
    const read = await GET(new Request('https://qit.test/api/daily'));
    expect(today).toHaveBeenCalledWith(await auth()); expect(read.headers.get('cache-control')).toBe('private, no-store');
  });
  it('pages saved history and rejects malformed cursors', async () => {
    const response = await GET(new Request('https://qit.test/api/daily?history=1&cursor=2026-10-02'));
    expect(response.status).toBe(200); expect(history).toHaveBeenCalledWith(await auth(), '2026-10-02');
    for (const query of ['history=2', 'history=1&cursor=../secret', 'cursor=2026-10-02', 'steamId=other']) {
      expect((await GET(new Request(`https://qit.test/api/daily?${query}`))).status).toBe(400);
    }
  });
  it('handles conflict, invalid settings and service failures without exposing details', async () => {
    act.mockRejectedValueOnce(new DailyConflict('Reload today’s pick'));
    expect((await POST(post(action))).status).toBe(409);
    save.mockRejectedValueOnce(new DailyInputError('Unavailable mode'));
    expect((await POST(post({ action: 'settings', settings: {} }))).status).toBe(400);
    today.mockRejectedValueOnce(new Error('secret database path'));
    const response = await GET(new Request('https://qit.test/api/daily'));
    expect(response.status).toBe(502); expect(JSON.stringify(await response.json())).not.toContain('secret'); expect(log).toHaveBeenCalled();
  });
  it('saves preferences and refuses extra settings keys', async () => {
    const settings = { mode: 'pure-random', antiRepeatDays: 7 };
    expect((await POST(post({ action: 'settings', settings }))).status).toBe(200);
    expect(save).toHaveBeenCalledWith(await auth(), settings);
    expect((await POST(post({ action: 'settings', settings, steamId: 'other' }))).status).toBe(400);
  });
  it('rate limits a user before further daily work', async () => {
    for (let i = 0; i < 20; i++) expect((await POST(post(action))).status).toBe(200);
    const response = await POST(post(action)); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBeTruthy();
    expect(act).toHaveBeenCalledTimes(20);
  });
});
