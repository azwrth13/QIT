import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Game } from '../src/lib/games';

const { recentRolls, markPlayed } = vi.hoisted(() => ({ recentRolls: vi.fn(), markPlayed: vi.fn() }));
vi.mock('../src/lib/history/rolls', () => ({ recentRolls, markPlayed }));
import { detectPlayedRolls, hasPlayedDelta } from '../src/lib/history/played';

const steamId = '76561198000000000';
const game = (appid: number, minutes: number, rtime: number | null = null): Game =>
  ({ appid, name: 'Game', img_icon_url: '', playtime_forever: minutes, rtime_last_played: rtime });
const ROLL_AT = new Date(1_000_000_000);
const roll = (id: string, appid: number, playtimeAtRoll: number | null, at = ROLL_AT, playedAt: Date | null = null) =>
  ({ id, appid, playtimeAtRoll, at, playedAt });

beforeEach(() => {
  vi.resetAllMocks();
  recentRolls.mockResolvedValue([]);
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
    recentRolls.mockResolvedValue([
      roll('nine', 620, 101), roll('ten', 730, 100), roll('unknown', 570, null), roll('missing-game', 400, 0),
    ]);
    const games = [game(620, 110), game(730, 110), game(570, 110)];
    expect(await detectPlayedRolls(steamId, { games, playtimeHidden: false }, 1000)).toBe(1);
    expect(recentRolls).toHaveBeenCalledWith(steamId, 1000, 1000);
    expect(markPlayed.mock.calls).toEqual([[steamId, 'ten', 'sync', 1000]]);
  });

  it('does not mark growth Steam last played before the roll (stale baseline)', async () => {
    const rolledAt = ROLL_AT.getTime() / 1000;
    // Last sync showed 100; the user played 60 minutes, rolled with the stale baseline, then synced.
    recentRolls.mockResolvedValue([roll('stale', 620, 100)]);
    expect(await detectPlayedRolls(steamId, { games: [game(620, 160, rolledAt - 1)], playtimeHidden: false })).toBe(0);
    expect(markPlayed).not.toHaveBeenCalled();
    expect(await detectPlayedRolls(steamId, { games: [game(620, 160, rolledAt)], playtimeHidden: false })).toBe(1);
    expect(markPlayed.mock.calls).toEqual([[steamId, 'stale', 'sync', expect.any(Number)]]);
  });

  it('marks only the newest qualifying roll of a game per play session', async () => {
    const newer = roll('newer', 620, 100, new Date(ROLL_AT.getTime() + 2000));
    const older = roll('older', 620, 100, new Date(ROLL_AT.getTime() + 1000));
    const oldest = roll('oldest', 620, 90);
    recentRolls.mockResolvedValue([newer, older, oldest]);
    expect(await detectPlayedRolls(steamId, { games: [game(620, 110)], playtimeHidden: false })).toBe(1);
    expect(markPlayed.mock.calls.map(call => call[1])).toEqual(['newer']);
  });

  it('skips a newer roll the session predates but never walks back past a played roll', async () => {
    const rolledAt = ROLL_AT.getTime() / 1000;
    const after = roll('after-play', 620, 100, new Date(ROLL_AT.getTime() + 60_000));
    recentRolls.mockResolvedValue([after, roll('before-play', 620, 100)]);
    const games = [game(620, 160, rolledAt + 1)];
    expect(await detectPlayedRolls(steamId, { games, playtimeHidden: false })).toBe(1);
    expect(markPlayed.mock.calls.map(call => call[1])).toEqual(['before-play']);
    // Re-sync with unchanged playtime: the marked roll stops the walk, so an older qualifying roll stays pending.
    markPlayed.mockClear();
    recentRolls.mockResolvedValue([
      after, roll('before-play', 620, 100, ROLL_AT, ROLL_AT), roll('older', 620, 90, new Date(ROLL_AT.getTime() - 2000)),
    ]);
    expect(await detectPlayedRolls(steamId, { games, playtimeHidden: false })).toBe(0);
    expect(markPlayed).not.toHaveBeenCalled();
  });

  it('does not read history or write marks for hidden playtime, even if supplied totals grow', async () => {
    expect(await detectPlayedRolls(steamId, { games: [game(620, 110)], playtimeHidden: true })).toBe(0);
    expect(recentRolls).not.toHaveBeenCalled();
    expect(markPlayed).not.toHaveBeenCalled();
  });

  it('does no history work for an empty library', async () => {
    expect(await detectPlayedRolls(steamId, { games: [], playtimeHidden: false })).toBe(0);
    expect(recentRolls).not.toHaveBeenCalled();
  });

  it('restricts detection to rolls predating the Steam snapshot', async () => {
    await detectPlayedRolls(steamId, { games: [game(620, 110)], playtimeHidden: false }, 2000, 1000);
    expect(recentRolls).toHaveBeenCalledWith(steamId, 2000, 1000);
  });

  it('counts only new marks when another writer wins or the roll disappears', async () => {
    recentRolls.mockResolvedValue([roll('manual-won', 620, 0), roll('deleted', 730, 0)]);
    markPlayed.mockResolvedValueOnce({ outcome: 'unchanged' }).mockResolvedValueOnce({ outcome: 'not_found' });
    expect(await detectPlayedRolls(steamId, { games: [game(620, 10), game(730, 10)], playtimeHidden: false })).toBe(0);
    expect(markPlayed).toHaveBeenCalledTimes(2);
  });
});
