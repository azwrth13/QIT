import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { readIndex, library } = vi.hoisted(() => ({ readIndex: vi.fn(), library: vi.fn() }));
vi.mock('../src/lib/store/lib-index', () => ({ readLibIndex: readIndex }));
vi.mock('../src/lib/social/libraries', () => ({ getSteamLibrary: library }));
import { getSharedDetails } from '../src/lib/social/dashboard';
import { getRecentDetails, RECENT_TTL_MS, type RecentDeps } from '../src/lib/social/recent';
const me = '76561198000000001', pal = '76561198000000002';
beforeEach(() => { vi.clearAllMocks(); });
describe('shared details', () => {
  it('returns the strict intersection and individual friend playtime, never friend-only games', async () => {
    readIndex.mockResolvedValue({ built: true, entries: new Map([[620, { n: 'Portal 2', p: 10 }], [440, { n: 'TF2' }]]) });
    library.mockResolvedValue({ steamId: pal, state: 'ok', games: new Map([[620, { n: 'Portal 2', p: 120 }], [730, { n: 'CS2' }]]) });
    expect(await getSharedDetails(me, pal, true)).toEqual({ state: 'ok', count: 1, games: [{ appid: 620, name: 'Portal 2', friendMinutes: 120 }] });
    expect(await getSharedDetails(me, pal, false)).toEqual({ state: 'ok', count: 1 });
    expect(library).toHaveBeenCalledWith(pal, { client: expect.any(Object) });
  });
  it.each(['private', 'not_found', 'error'])('keeps %s separate from zero and does not read the owner index', async state => {
    library.mockResolvedValue({ steamId: pal, state, games: new Map() });
    expect(await getSharedDetails(me, pal, false)).toMatchObject({ state, message: expect.any(String) });
    expect(readIndex).not.toHaveBeenCalled();
  });
  it('explains an unsynced owner library', async () => {
    library.mockResolvedValue({ steamId: pal, state: 'ok', games: new Map() });
    readIndex.mockResolvedValue({ built: false });
    expect(await getSharedDetails(me, pal, false)).toMatchObject({ state: 'error', message: expect.stringMatching(/Sync/) });
  });
});
describe('recent activity cache', () => {
  const result = { state: 'public' as const, totalCount: 1, games: [{ appid: 620, name: 'Portal 2', img_icon_url: '', playtime_forever: 120, playtime_2weeks: 60 }] };
  const setup = () => {
    let now = 1000;
    let record: Awaited<ReturnType<RecentDeps['read']>> = null;
    const deps: RecentDeps = {
      now: () => now, read: vi.fn(async () => record),
      write: vi.fn(async (_id, value) => { record = value; }), fetch: vi.fn(async () => result),
    };
    return { deps, advance: () => { now += RECENT_TTL_MS; }, expires: () => record?.expiresAt.toMillis() };
  };
  it('reuses cached recent activity until its ten-minute expiry', async () => {
    const { deps, advance, expires } = setup();
    expect(await getRecentDetails(pal, deps)).toEqual({ state: 'ok', games: result.games });
    expect(expires()).toBe(1000 + RECENT_TTL_MS);
    await getRecentDetails(pal, deps); expect(deps.fetch).toHaveBeenCalledTimes(1);
    advance(); await getRecentDetails(pal, deps); expect(deps.fetch).toHaveBeenCalledTimes(2);
  });
  it('coalesces concurrent expansion requests', async () => {
    const { deps } = setup();
    await Promise.all([getRecentDetails(pal, deps), getRecentDetails(pal, deps)]);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });
  it('shows cached private details plainly without fetching Steam', async () => {
    const { deps } = setup();
    deps.read = vi.fn(async () => ({ result: { state: 'private' as const }, expiresAt: Timestamp.fromMillis(10000) }));
    expect(await getRecentDetails(pal, deps)).toMatchObject({ state: 'private', message: expect.stringMatching(/cannot read/) });
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
