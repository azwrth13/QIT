export const MAX_GENRE_APPIDS = 500;

export function validateAppIds(body: unknown): number[] | null {
  if (!body || typeof body !== 'object' || !('appids' in body)) return null;
  const appids = body.appids;
  if (!Array.isArray(appids) || !appids.length || appids.length > MAX_GENRE_APPIDS ||
      !appids.every(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647) ||
      new Set(appids).size !== appids.length) return null;
  return appids;
}

export async function fetchGenreBatches(appids: number[], fetcher: typeof fetch = fetch) {
  const result = { genres: {} as Record<number, string[]>, successCount: 0, errorCount: 0 };
  for (let i = 0; i < appids.length; i += MAX_GENRE_APPIDS) {
    const response = await fetcher('/api/games/genres', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appids: appids.slice(i, i + MAX_GENRE_APPIDS) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unknown error');
    Object.assign(result.genres, data.genres);
    result.successCount += data.successCount ?? 0;
    result.errorCount += data.errorCount ?? 0;
  }
  return result;
}
