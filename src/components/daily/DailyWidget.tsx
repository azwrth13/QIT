'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { isNavEnabled } from '@/app/navbar/nav-items';
import { renderReasons } from '@/lib/roulette/reasons';
import type { DailyResponse } from '@/lib/daily/model';
import { dailyJson, loadDaily } from './client';

export function DailyWidgetContent({ data, loading, error }: { data: DailyResponse | null; loading: boolean; error: string }) {
  if (!isNavEnabled('daily')) return null;
  return <section aria-label="Daily QIT" className="mb-8 border-4 border-black bg-neobrutal-yellow p-6 text-black shadow-neobrutal">
    <h2 className="text-xl font-bold">Daily QIT</h2>
    {loading ? <p role="status">Choosing your daily game…</p> : error ? <p role="alert">{error}</p> : data?.today ? <>
      <p className="mt-2 text-lg font-bold">{data.today.selection.card?.name ?? 'No eligible game today'}</p>
      <p>{data.today.date} · {data.today.status}</p>
      {data.today.selection.card && <p className="mt-2">{renderReasons(data.today.selection.card.reasons)[0]}</p>}
    </> : <p>Your daily game is waiting.</p>}
    <Link href="/daily" className="mt-3 inline-block font-bold underline">Open Daily QIT</Link>
  </section>;
}
export function DailyWidget() {
  const [data, setData] = useState<DailyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isNavEnabled('daily')) return;
    let cancelled = false;
    let pending = false;
    let initialized = false;
    let nextDayAt = 0;
    let timer: number | undefined;
    const refresh = () => {
      if (document.visibilityState === 'hidden' || pending) return;
      pending = true;
      const request = initialized ? dailyJson<DailyResponse>('/api/daily') : loadDaily();
      void request.then(value => {
        if (cancelled) return;
        initialized = true; nextDayAt = value.nextDayAt; setData(value); setError('');
        window.clearTimeout(timer);
        timer = window.setTimeout(refresh, Math.max(100, value.nextDayAt - Date.now() + 100));
      }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load today’s game'); })
        .finally(() => { pending = false; if (!cancelled) setLoading(false); });
    };
    const onFocus = () => { if (!initialized || Date.now() >= nextDayAt) refresh(); };
    refresh();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, []);
  return <DailyWidgetContent data={data} loading={loading} error={error} />;
}
