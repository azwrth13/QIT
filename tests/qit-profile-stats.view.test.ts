import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProfileStats } from '../src/app/profile/ProfileStatsView';

const respond = (body: string, status: number) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));

describe('profile statistics client loading', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('returns parsed statistics from a successful response', async () => {
    respond(JSON.stringify({ totalGames: 2 }), 200);
    await expect(fetchProfileStats()).resolves.toEqual({ totalGames: 2 });
  });
  it('surfaces the safe error envelope message', async () => {
    respond(JSON.stringify({ error: { code: 'unavailable', message: 'Your QIT stats are unavailable right now' } }), 502);
    await expect(fetchProfileStats()).rejects.toThrow('Your QIT stats are unavailable right now');
  });
  it('uses the friendly fallback when a failed response is not JSON', async () => {
    respond('<html>Bad gateway</html>', 502);
    await expect(fetchProfileStats()).rejects.toThrow(/^Unable to load your QIT stats$/);
  });
  it('uses the friendly fallback when a successful response is not JSON', async () => {
    respond('<html>oops</html>', 200);
    await expect(fetchProfileStats()).rejects.toThrow(/^Unable to load your QIT stats$/);
  });
});
