export const MAX_GENRE_APPIDS = 40;

export function validateAppIds(body: unknown): number[] | null {
  if (!body || typeof body !== 'object' || !('appids' in body)) return null;
  const appids = body.appids;
  if (!Array.isArray(appids) || !appids.length || appids.length > MAX_GENRE_APPIDS ||
      !appids.every(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647) ||
      new Set(appids).size !== appids.length) return null;
  return appids;
}
