import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Game } from '../src/lib/games';

const { recentUnplayedRolls, markPlayed } = vi.hoisted(() => ({ recentUnplayedRolls: vi.fn(), markPlayed: vi.fn() }));
vi.mock('../src/lib/history/rolls', () => ({ recentUnplayedRolls, markPlayed }));
import { detectPlayedRolls, hasPlayedDelta } from '../src/lib/history/played';

const steamId = '76561198000000000';
const game = (appid: number, minutes: number): Game => ({ appid, name: 'Game', img_icon_url: '', playtime_forever: minutes });

beforeEach(() => {
  vi.resetAllMocks();
  recentUnplayedRolls.mockResolvedValue([]);
  markPlayed.mockResolvedValue({ outcome: 'updated' });
});

describe('played delta', () => {
  it.each([
    [100, 109, false], [100, 110, true], [100, 111, true], [0, 10, true],
    [100, 90, false], [100, 100, false], [null, 100, false], [0, undefined, false],
    [NaN, 100, false], [0, Infinity, false], [-10, 10, false], [0, -10, false],
  ])('compares baseline %s with current %s: %s', (baseline, current, expected) => {
    expect(hasPlayedDelta(baseline, current)).toBe(expected);
  });
});

describe('sync detection', () => {
  it('marks qualifying rolls using their own baseline and records sync as the source', async () => {
    recentUnplayedRolls.mockResolvedValue([
      { id: 'nine', appid: 620, playtimeAtRoll: 101 },
      { id: 'ten', appid: 620, playtimeAtRoll: 100 },
      { id: 'unknown', appid: 620, playtimeAtRoll: null },
      { id: 'missing-game', appid: 400, playtimeAtRoll: 0 },
    ]);
    expect(await detectPlayedRolls(steamId, { games: [game(620, 110)], playtimeHidden: false }, 1000)).toBe(1);
    expect(recentUnplayedRolls).toHaveBeenCalledWith(steamId, 1000, 1000);
    expect(markPlayed.mock.calls).toEqual([[steamId, 'ten', 'sync', 1000]]);
  });

  it('does not read history or write marks for hidden playtime, even if supplied totals grow', async () => {
    expect(await detectPlayedRolls(steamId, { games: [game(620, 110)], playtimeHidden: true })).toBe(0);
    expect(recentUnplayedRolls).not.toHaveBeenCalled();
    expect(markPlayed).not.toHaveBeenCalled();
  });

  it('does no history work for an empty library', async () => {
    expect(await detectPlayedRolls(steamId, { games: [], playtimeHidden: false })).toBe(0);
    expect(recentUnplayedRolls).not.toHaveBeenCalled();
  });

  it('restricts detection to rolls predating the Steam snapshot', async () => {
    await detectPlayedRolls(steamId, { games: [game(620, 110)], playtimeHidden: false }, 2000, 1000);
    expect(recentUnplayedRolls).toHaveBeenCalledWith(steamId, 2000, 1000);
  });

  it('counts only new marks when another writer wins or the roll disappears', async () => {
    recentUnplayedRolls.mockResolvedValue([
      { id: 'manual-won', appid: 620, playtimeAtRoll: 0 },
      { id: 'deleted', appid: 620, playtimeAtRoll: 0 },
    ]);
    markPlayed.mockResolvedValueOnce({ outcome: 'unchanged' }).mockResolvedValueOnce({ outcome: 'not_found' });
    expect(await detectPlayedRolls(steamId, { games: [game(620, 10)], playtimeHidden: false })).toBe(0);
  });
});
