import { describe, expect, it, vi } from 'vitest';
import { fetchGenreBatches, MAX_GENRE_APPIDS } from '../src/lib/genres';

describe('fetchGenreBatches', () => {
  it('splits large libraries into accepted batches and merges the results', async () => {
    const appids = Array.from({ length: 1_201 }, (_, i) => i + 1);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const batch: number[] = JSON.parse(String(init?.body)).appids;
      return Response.json({ genres: Object.fromEntries(batch.map(id => [id, ['Action']])), successCount: batch.length, errorCount: 0 });
    });
    const result = await fetchGenreBatches(appids, fetcher as typeof fetch);
    const batches = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).appids as number[]);
    expect(batches.map(batch => batch.length)).toEqual([MAX_GENRE_APPIDS, MAX_GENRE_APPIDS, 201]);
    expect(batches.flat()).toEqual(appids);
    expect(Object.keys(result.genres)).toHaveLength(1_201);
    expect(result).toMatchObject({ successCount: 1_201, errorCount: 0 });
  });
  it('surfaces the server error for a rejected batch', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'Invalid appids' }, { status: 400 }));
    await expect(fetchGenreBatches([1], fetcher as typeof fetch)).rejects.toThrow('Invalid appids');
  });
});
