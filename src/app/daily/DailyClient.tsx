'use client';

import { useCallback, useEffect, useState } from 'react';
import { DailyView, DAILY_BUTTON } from '@/components/daily/DailyView';
import { dailyAction, dailyJson, loadDaily, updateDailySettings } from '@/components/daily/client';
import { ANTI_REPEAT_OPTIONS, DEFAULT_DAILY_SETTINGS, type DailyAction, type DailyResponse, type DailySettings, type DailyView as DailyRecord } from '@/lib/daily/model';
import type { ModesCatalog } from '@/lib/roulette/service';

export function DailyClient() {
  const [data, setData] = useState<DailyResponse | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<DailySettings>(DEFAULT_DAILY_SETTINGS);
  const [modes, setModes] = useState<ModesCatalog['modes']>([]);
  const [history, setHistory] = useState<DailyRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const refresh = useCallback(async () => {
    const value = await loadDaily();
    setData(value); setSettings(value.settings); setError('');
  }, []);
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([loadDaily(), dailyJson<ModesCatalog>('/api/roulette/modes')]).then(([daily, catalog]) => {
      if (cancelled) return;
      if (daily.status === 'fulfilled') { setData(daily.value); setSettings(daily.value.settings); }
      else setError(daily.reason instanceof Error ? daily.reason.message : 'Unable to load Daily QIT');
      if (catalog.status === 'fulfilled') setModes(catalog.value.modes.filter(mode => mode.scopes.includes('library')));
      else setMessage('Mode choices are unavailable right now. Your saved pick and daily actions still work.');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);
  // Refresh at the local boundary and when returning to a stale tab. Server-side date checks also protect actions.
  useEffect(() => {
    if (!data) return;
    const check = () => { if (Date.now() >= data.nextDayAt) void refresh().catch(err => setError(err.message)); };
    const timer = window.setTimeout(check, Math.max(100, data.nextDayAt - Date.now() + 100));
    window.addEventListener('focus', check);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', check); };
  }, [data, refresh]);
  async function act(action: DailyAction) {
    if (!data?.today || busy) return;
    setBusy(true); setError(''); setMessage('');
    try { setData(await dailyAction(data.today, action)); setHistoryLoaded(false); setHistory([]); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to update today’s pick'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try { await updateDailySettings(settings); setMessage('Default settings saved for tomorrow. Today’s pick and reroll rules stay the same.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to save settings'); }
    finally { setBusy(false); }
  }
  async function browse(more = false) {
    setBusy(true); setError('');
    try {
      const page = await dailyJson<{ dailies: DailyRecord[]; nextCursor: string | null }>(`/api/daily?history=1${more && cursor ? `&cursor=${cursor}` : ''}`);
      setHistory(old => more ? [...old, ...page.dailies] : page.dailies); setCursor(page.nextCursor); setHistoryLoaded(true);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load previous dailies'); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 text-black">
    <h1 className="text-3xl font-bold">Daily QIT</h1>
    <p>One game from your library each local day. Your saved pick stays here when you return.</p>
    {error && <div role="alert" className="border-4 border-black bg-neobrutal-pink p-4">{error}
      <button disabled={busy} className={`${DAILY_BUTTON} ml-3`} onClick={() => void refresh().catch(err => setError(err.message))}>Reload today</button></div>}
    {message && <p role="status">{message}</p>}
    {loading ? <p role="status">Loading today’s selection…</p> : data?.today && <DailyView daily={data.today} busy={busy} onAction={action => void act(action)} />}
    <section className="space-y-3 border-4 border-black bg-white p-5">
      <h2 className="text-xl font-bold">Daily defaults</h2><p>Changes take effect on the next local day. Rerolls use today’s saved settings.</p>
      <label className="block font-bold">Mode <select aria-label="Daily mode" disabled={busy || loading} className="ml-2 max-w-full border-2 border-black p-2"
        value={settings.mode} onChange={event => setSettings({ ...settings, mode: event.target.value as DailySettings['mode'] })}>
        <option value="backlog-mix">Backlog mix</option>
        {settings.mode !== 'backlog-mix' && !modes.some(mode => mode.id === settings.mode) && <option value={settings.mode}>{settings.mode}</option>}
        {modes.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
      </select></label>
      <label className="block font-bold">Avoid recent recommendations <select aria-label="Anti-repeat window" disabled={busy || loading} className="ml-2 border-2 border-black p-2"
        value={settings.antiRepeatDays} onChange={event => setSettings({ ...settings, antiRepeatDays: Number(event.target.value) })}>
        {ANTI_REPEAT_OPTIONS.map(days => <option key={days} value={days}>{days === 0 ? 'Off' : `${days} days`}</option>)}
      </select></label>
      <button disabled={busy || loading || !data} className={DAILY_BUTTON} onClick={() => void save()}>Save defaults</button>
      <p className="text-sm">Backlog mix combines Dust Collector, Rediscovery, Finish Something and Something Different. Modes needing friends are available through their group surfaces when those ship.</p>
    </section>
    <section className="space-y-4"><h2 className="text-xl font-bold">Previous dailies</h2>
      <button className={DAILY_BUTTON} disabled={busy} onClick={() => void browse()}>Browse saved selections</button>
      {historyLoaded && history.filter(daily => daily.date !== data?.today?.date).length === 0 && <p>No previous dailies yet. Your first selection is saved today.</p>}
      {history.filter(daily => daily.date !== data?.today?.date).map(daily => <details key={daily.date} className="border-2 border-black bg-white p-4">
        <summary className="cursor-pointer font-bold">{daily.date} · {daily.selection.card?.name ?? 'No eligible game'} · {daily.status}</summary>
        <div className="mt-4"><DailyView daily={daily} historical /></div>
      </details>)}
      {historyLoaded && cursor && <button className={DAILY_BUTTON} disabled={busy} onClick={() => void browse(true)}>Load older dailies</button>}
    </section>
  </main>;
}
