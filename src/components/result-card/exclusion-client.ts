import type { ExclusionScope } from '@/lib/store/types';

export const SCOPE_LABELS: Record<ExclusionScope, string> = {
  day: 'Not tonight', session: 'Hide for this session', '7d': 'Hide for 7 days', forever: "Don't recommend again",
};

export async function updateExclusion(body: { action: 'hide' | 'unhide' | 'end-session'; appid?: number; scope?: ExclusionScope; sessionId?: string }) {
  if (body.action === 'hide' && body.scope === 'day') {
    const profile = await fetch('/api/user/profile', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    if (!profile.ok) throw new Error('Unable to save your timezone');
  }
  const response = await fetch('/api/user/exclusions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? 'Unable to update hidden games');
  return data;
}
