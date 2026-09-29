import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastPlayedAt, type Game } from '../src/lib/games';
import {
  detectPlaytimeHidden, fromGameDoc, fromIndexEntry, fromOwnedGame, indexPatchFor, librarySignals, planSync,
  PLAYTIME_HIDDEN_MIN_GAMES, toGameDoc, toIndexFields,
} from '../src/lib/library/model';
import { getSteamGames } from '../src/lib/steam';
import type { OwnedGame } from '../src/lib/steam/owned';
import type { LibIndexEntry } from '../src/lib/store/types';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const owned = (overrides: Partial<OwnedGame> = {}): OwnedGame => ({
  appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 0, playtime_2weeks: 0,
  rtime_last_played: null, has_community_visible_stats: false, ...overrides,
});

describe('lastPlayedAt', () => {
  it('keeps real times, reads 0 as never only without playtime, and anything else as unknown', () => {
    expect(lastPlayedAt(1_700_000_000, 50)).toBe(1_700_000_000);
    expect(lastPlayedAt(1_700_000_000, 0)).toBe(1_700_000_000);
    expect(lastPlayedAt(0, 0)).toBe(0);
    expect(lastPlayedAt(0)).toBe(0);
    expect(lastPlayedAt(0, 30)).toBeNull();
    for (const value of [undefined, null, -1, Number.NaN, '1700000000']) expect(lastPlayedAt(value, 0)).toBeNull();
  });
});

describe('getSteamGames', () => {
  it('asks for played free games and keeps the recency and stats fields', async () => {
    const urls: URL[] = [];
    vi.stubEnv('STEAM_API_KEY', 'test-key');
    vi.stubGlobal('fetch', async (url: URL) => {
      urls.push(new URL(url));
      return Response.json({ response: { game_count: 3, games: [
        { appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 90, playtime_2weeks: 30, rtime_last_played: 1_700_000_000, has_community_visible_stats: true },
        { appid: 440, name: 'Team Fortress 2', playtime_forever: 0, rtime_last_played: 0 },
        { appid: 70, name: 'Half-Life', playtime_forever: 12, rtime_last_played: 0 },
      ] } });
    });
    expect(await getSteamGames('76561198000000000')).toEqual([
      { appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 90, playtime_2weeks: 30, rtime_last_played: 1_700_000_000, has_community_visible_stats: true },
      { appid: 440, name: 'Team Fortress 2', img_icon_url: '', playtime_forever: 0, playtime_2weeks: 0, rtime_last_played: 0, has_community_visible_stats: false },
      { appid: 70, name: 'Half-Life', img_icon_url: '', playtime_forever: 12, playtime_2weeks: 0, rtime_last_played: null, has_community_visible_stats: false },
    ]);
    expect(urls[0].searchParams.get('include_played_free_games')).toBe('true');
    expect(urls[0].searchParams.get('include_appinfo')).toBe('true');
  });

  it('reports an account that never sends rtime_last_played as unknown, not never played', async () => {
    vi.stubEnv('STEAM_API_KEY', 'test-key');
    vi.stubGlobal('fetch', async () => Response.json({ response: { game_count: 1, games: [{ appid: 620, name: 'Portal 2', playtime_forever: 0 }] } }));
    expect((await getSteamGames('76561198000000000'))?.[0].rtime_last_played).toBeNull();
  });
});

describe('game conversions', () => {
  it('maps a Steam game to a Game, a per-game document and index fields', () => {
    const game = fromOwnedGame(owned({ playtime_forever: 90, playtime_2weeks: 30, rtime_last_played: 1_700_000_000, has_community_visible_stats: true }));
    expect(toGameDoc(game)).toEqual({
      appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 90, playtime_2weeks: 30,
      rtime_last_played: 1_700_000_000, has_community_visible_stats: true,
    });
    expect(toIndexFields(game)).toEqual({ n: 'Portal 2', i: 'abc', p: 90, w: 30, r: 1_700_000_000, s: 1 });
    expect(fromIndexEntry(620, toIndexFields(game))).toEqual(game);
  });

  it('stores never played as r 0, and leaves r out when it is unknown', () => {
    expect(toIndexFields(fromOwnedGame(owned({ rtime_last_played: 0 })))).toEqual({ n: 'Portal 2', i: 'abc', p: 0, w: 0, r: 0, s: 0 });
    expect(toIndexFields(fromOwnedGame(owned({ rtime_last_played: 0, playtime_forever: 5 })))).not.toHaveProperty('r');
    expect(toIndexFields(fromOwnedGame(owned({ rtime_last_played: null })))).not.toHaveProperty('r');
    expect(fromIndexEntry(620, { n: 'Portal 2', p: 5, r: 0 }).rtime_last_played).toBeNull();
  });

  it('reads index entries written by other packages without leaking their fields, and missing fields as unknown', () => {
    expect(fromIndexEntry(620, { n: 'Portal 2', f: 3, ap: 50, au: 1, at: 2 })).toEqual({
      appid: 620, name: 'Portal 2', img_icon_url: '', playtime_forever: 0, rtime_last_played: null, has_community_visible_stats: false,
    });
  });

  it('reads legacy per-game documents written before the extra fields existed', () => {
    expect(fromGameDoc({ appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 90 })).toEqual({
      appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 90, rtime_last_played: null,
    });
    expect(fromGameDoc({ ...toGameDoc(fromOwnedGame(owned({ playtime_2weeks: 0, has_community_visible_stats: true }))) })).toMatchObject({
      playtime_2weeks: 0, has_community_visible_stats: true, rtime_last_played: null,
    });
    for (const data of [undefined, {}, { appid: '620', name: 'x' }, { appid: 620 }, { appid: -1, name: 'x' }]) expect(fromGameDoc(data)).toBeNull();
  });
});

describe('indexPatchFor', () => {
  const game = fromOwnedGame(owned({ playtime_forever: 90, rtime_last_played: 1_700_000_000 }));

  it('is null when this package\'s fields already match, whatever other packages stored', () => {
    expect(indexPatchFor(game, { ...toIndexFields(game), f: 7, ap: 100, au: 3, at: 3 })).toBeNull();
  });

  it('sends every owned field and clears a last-played time that became unknown, never touching other fields', () => {
    const stored: LibIndexEntry = { ...toIndexFields(game), f: 7, ap: 100 };
    const next = { ...game, playtime_forever: 120, rtime_last_played: null };
    expect(indexPatchFor(next, stored)).toEqual({ n: 'Portal 2', i: 'abc', p: 120, w: 0, s: 0, r: null });
    expect(indexPatchFor(game, undefined)).toEqual(toIndexFields(game));
  });
});

describe('planSync', () => {
  const games = [620, 400, 440].map(appid => fromOwnedGame(owned({ appid, name: `Game ${appid}`, playtime_forever: appid })));

  it('writes new and changed games, skips unchanged ones, and removes games no longer owned', () => {
    const previous = new Map<number, LibIndexEntry | undefined>([
      [620, toIndexFields(games[0])],
      [400, { ...toIndexFields(games[1]), p: 1 }],
      [70, { n: 'Half-Life' }],
    ]);
    const plan = planSync(games, previous);
    expect(plan.changed.map(game => game.appid)).toEqual([400, 440]);
    expect([...plan.patches.keys()]).toEqual([400, 440]);
    expect(plan.removed).toEqual([70]);
  });

  it('rewrites every game once when only legacy per-game documents exist', () => {
    const plan = planSync(games, new Map([[620, undefined], [70, undefined]]));
    expect(plan.changed).toHaveLength(3);
    expect(plan.removed).toEqual([70]);
  });

  it('ignores duplicate and invalid appids from Steam', () => {
    const plan = planSync([...games, games[0], { appid: 0, name: 'Bad' }, { appid: 1.5, name: 'Bad' }] as Game[], new Map());
    expect(plan.changed.map(game => game.appid)).toEqual([620, 400, 440]);
  });

  it('removes everything when the library is now empty', () => {
    expect(planSync([], new Map(games.map(game => [game.appid, toIndexFields(game)])))).toEqual({
      changed: [], patches: new Map(), removed: [620, 400, 440],
    });
  });
});

describe('detectPlaytimeHidden', () => {
  const zero = (count: number, extra: Partial<OwnedGame> = {}) =>
    Array.from({ length: count }, (_, index) => fromOwnedGame(owned({ appid: 10 * (index + 1), ...extra })));

  it('flags a library of several games that reports no playtime anywhere', () => {
    expect(detectPlaytimeHidden(zero(PLAYTIME_HIDDEN_MIN_GAMES))).toBe(true);
    expect(detectPlaytimeHidden(zero(200))).toBe(true);
  });

  it('flags a small all-zero library when Steam still reports that a game was played', () => {
    expect(detectPlaytimeHidden(zero(1, { rtime_last_played: 1_700_000_000 }))).toBe(true);
  });

  it('does not flag empty or small unplayed libraries, or any library with some playtime', () => {
    expect(detectPlaytimeHidden([])).toBe(false);
    expect(detectPlaytimeHidden(zero(PLAYTIME_HIDDEN_MIN_GAMES - 1))).toBe(false);
    expect(detectPlaytimeHidden(zero(PLAYTIME_HIDDEN_MIN_GAMES - 1, { rtime_last_played: 0 }))).toBe(false);
    expect(detectPlaytimeHidden([...zero(50), fromOwnedGame(owned({ appid: 7, playtime_forever: 1 }))])).toBe(false);
    expect(detectPlaytimeHidden([...zero(50), fromOwnedGame(owned({ appid: 7, playtime_2weeks: 3 }))])).toBe(false);
  });
});

describe('librarySignals', () => {
  it('maps a game to roulette library signals, keeping unknown apart from zero', () => {
    expect(librarySignals(fromOwnedGame(owned({ playtime_forever: 90, playtime_2weeks: 30, rtime_last_played: 1_700_000_000 })))).toEqual({
      name: 'Portal 2', iconHash: 'abc', playtimeForever: 90, playtime2Weeks: 30, lastPlayedAt: 1_700_000_000,
    });
    expect(librarySignals({ appid: 620, name: 'Portal 2' })).toEqual({
      name: 'Portal 2', iconHash: null, playtimeForever: 0, playtime2Weeks: null, lastPlayedAt: null,
    });
  });

  it('treats recent playtime and "never played" as unknown when playtime is hidden', () => {
    const game = fromOwnedGame(owned({ rtime_last_played: 0 }));
    expect(librarySignals(game)).toMatchObject({ playtime2Weeks: 0, lastPlayedAt: 0 });
    expect(librarySignals(game, true)).toMatchObject({ playtime2Weeks: null, lastPlayedAt: null });
    expect(librarySignals(fromOwnedGame(owned({ rtime_last_played: 1_700_000_000 })), true).lastPlayedAt).toBe(1_700_000_000);
  });
});
