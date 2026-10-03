import { beforeEach, describe, expect, it, vi } from 'vitest';
const { readIndex, library, recentGames } = vi.hoisted(() => ({ readIndex: vi.fn(), library: vi.fn(), recentGames: vi.fn() }));
vi.mock('../src/lib/store/lib-index', () => ({ readLibIndex: readIndex }));
vi.mock('../src/lib/social/libraries', () => ({ getSteamLibrary: library }));
vi.mock('../src/lib/steam/owned', () => ({ getRecentlyPlayedGames: recentGames }));
import { getSharedDetails } from '../src/lib/social/dashboard';
import { getRecentDetails } from '../src/lib/social/recent';
const me = '76561198000000001', pal = '76561198000000002';
beforeEach(() => { vi.clearAllMocks(); });
describe('shared details', () => {
  it('returns the strict intersection and individual friend playtime, never friend-only games', async () => {
    readIndex.mockResolvedValue({ built: true, entries: new Map([[620, { n: 'Portal 2', p: 10 }], [440, { n: 'TF2' }]]) });
    library.mockResolvedValue({ steamId: pal, state: 'ok', games: new Map([[620, { n: 'Portal 2', p: 120 }], [730, { n: 'CS2' }]]) });
    expect(await getSharedDetails(me, pal, true)).toEqual({ state: 'ok', count: 1, games: [{ appid: 620, name: 'Portal 2', friendMinutes: 120 }] });
    expect(await getSharedDetails(me, pal, false)).toEqual({ state: 'ok', count: 1 });
    expect(library).toHaveBeenCalledWith(pal);
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
describe('recent activity', () => {
  it('fetches up to five recent games for one player', async () => {
    const games = [{ appid: 620, name: 'Portal 2', img_icon_url: '', playtime_forever: 120, playtime_2weeks: 60 }];
    recentGames.mockResolvedValue({ state: 'public', totalCount: 1, games });
    expect(await getRecentDetails(pal)).toEqual({ state: 'ok', games });
    expect(recentGames).toHaveBeenCalledWith(pal, 5);
  });
  it('shows private recent activity plainly', async () => {
    recentGames.mockResolvedValue({ state: 'private' });
    expect(await getRecentDetails(pal)).toMatchObject({ state: 'private', message: expect.stringMatching(/cannot read/) });
  });
});
