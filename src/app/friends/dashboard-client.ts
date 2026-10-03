import { withHref, parseWithParam } from '@/lib/links/with-param';
import type { SharedDetails } from '@/lib/social/dashboard-types';
import type { Card } from '@/lib/roulette/types';

export const PAGE_SIZE = 14;
export async function requestJson<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(path, { method, cache: 'no-store', ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message ?? 'Request failed. Please try again.');
  return data as T;
}
export function details<T>(steamId: string, kind: 'shared' | 'recent', includeGames = false): Promise<T> {
  return requestJson('/api/steam/friends/details', { steamId, kind, includeGames });
}
export async function findShared(steamId: string) {
  // Refresh only this player's library first. Pool previews are deliberately cache-only.
  const shared = await details<SharedDetails>(steamId, 'shared', true);
  if (shared.state !== 'ok') throw new Error(shared.message);
  const pool = await requestJson<{ preview: { final: number } }>('/api/roulette/pool', { mode: 'pure-random', scope: { kind: 'pair', with: steamId } });
  return { shared, eligible: pool.preview.final };
}
export function spinWith(steamId: string) {
  return requestJson<{ card: Card | null; poolSize: number }>('/api/roulette/spin', { mode: 'pure-random', scope: { kind: 'pair', with: steamId } });
}
export function friendNightHref(selected: readonly string[], steamId: string) {
  return withHref('/friend-night', parseWithParam([...selected, steamId].join(',')));
}

/** No prefetch margin: a card must actually enter the viewport. Unsupported browsers use the explicit load button. */
export function observeCard(element: Element, load: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
  }, { rootMargin: '0px', threshold: 0 });
  observer.observe(element);
  return () => observer.disconnect();
}
