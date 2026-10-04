import { afterEach, describe, expect, it, vi } from 'vitest';
import { dailyAction, dailyJson, loadDaily, updateDailySettings } from '../src/components/daily/client';
import type { DailyView } from '../src/lib/daily/model';

afterEach(() => vi.unstubAllGlobals());
describe('Daily client API contract', () => {
  it('stores the browser timezone before the first daily read', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ tz: 'UTC' })).mockResolvedValueOnce(Response.json({ today: null }));
    vi.stubGlobal('fetch', fetcher);
    expect(await loadDaily()).toEqual({ today: null });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/user/profile', '/api/daily']);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    expect(fetcher.mock.calls[0][1].method).toBe('PATCH');
    expect(fetcher.mock.calls[1][1].cache).toBe('no-store');
  });
  it('refuses to create a daily when timezone persistence fails', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { message: 'Save timezone failed' } }, { status: 502 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(loadDaily()).rejects.toThrow('Save timezone failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sends the displayed date and revision for all actions and propagates stale-pick conflicts', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ error: { message: 'This pick changed' } }, { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    const daily = { date: '2026-10-03', rerolls: 2 } as DailyView;
    for (const action of ['accept', 'reroll', 'skip', 'played'] as const) {
      await expect(dailyAction(daily, action)).rejects.toThrow('This pick changed');
      expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ action, date: daily.date, revision: 2 });
    }
  });
  it('saves only preference fields and handles unreadable error bodies generically', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ settings: { mode: 'pure-random', antiRepeatDays: 0 } })).mockResolvedValueOnce(Response.json({}, { status: 502 }));
    vi.stubGlobal('fetch', fetcher);
    await updateDailySettings({ mode: 'pure-random', antiRepeatDays: 0 });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: 'settings', settings: { mode: 'pure-random', antiRepeatDays: 0 } });
    await expect(dailyJson('/api/daily')).rejects.toThrow('Unable to load Daily QIT');
  });
});
