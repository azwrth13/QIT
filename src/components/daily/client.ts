import type { DailyAction, DailyResponse, DailySettings, DailyView } from '@/lib/daily/model';

export async function dailyJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? 'Unable to load Daily QIT');
  return body as T;
}

/** Save the browser zone through the existing profile API before asking for a local-day selection. */
export async function loadDaily(): Promise<DailyResponse> {
  await dailyJson('/api/user/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
  return dailyJson<DailyResponse>('/api/daily');
}
export const dailyAction = (daily: DailyView, action: DailyAction) => dailyJson<DailyResponse>('/api/daily', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, date: daily.date, revision: daily.rerolls }),
});
export const updateDailySettings = (settings: DailySettings) => dailyJson<{ settings: DailySettings }>('/api/daily', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', settings }),
});
