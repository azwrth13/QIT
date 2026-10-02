import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { THRESHOLDS } from '../src/lib/roulette/thresholds';
import type { Candidate, ScoreContext } from '../src/lib/roulette/types';
import { getMode } from '../src/lib/roulette/modes';
import { renderReason } from '../src/lib/roulette/reasons';
import { roll } from '../src/lib/roulette/scoring';
import { runSpin, type PipelineDeps } from '../src/lib/roulette/pipeline';

const { ownLibrary, friendLibraries, readLive, refreshLive, readQit, readPublic } = vi.hoisted(() => ({
  ownLibrary: vi.fn(), friendLibraries: vi.fn(), readLive: vi.fn(), refreshLive: vi.fn(), readQit: vi.fn(), readPublic: vi.fn(),
}));
vi.mock('../src/lib/roulette/scopes/library', () => ({ libraryScope: { kind: 'library', resolve: ownLibrary } }));
vi.mock('../src/lib/social/libraries', async original => ({ ...await original<typeof import('../src/lib/social/libraries')>(), getLibraryFor: friendLibraries }));
vi.mock('../src/lib/social/store', () => ({ firestoreSocialStore: { readQitLibraries: readQit, readPublicLibraries: readPublic } }));
vi.mock('../src/lib/store/app-live', () => ({ readAppLive: readLive }));
vi.mock('../src/lib/apps/live-players', async original => ({
  ...await original<typeof import('../src/lib/apps/live-players')>(), getCurrentPlayers: refreshLive,
}));
import { friendsScope, pairScope } from '../src/lib/roulette/scopes/group';
import { loadLive } from '../src/lib/roulette/live';

const me = '76561198000000001', friend = '76561198000000002', other = '76561198000000003';
const now = 1_790_000_000_000;
const ctx: ScoreContext = { now: now / 1000, thresholds: THRESHOLDS, scope: { kind: 'library' } };
const groupCtx: ScoreContext = { ...ctx, scope: { kind: 'friends', with: [friend] } };
const candidate = (appid = 1): Candidate => ({ appid, signals: {
  library: { name: `Game ${appid}`, iconHash: null, playtimeForever: 60, playtime2Weeks: null, lastPlayedAt: null },
  store: { type: 'game', flags: { multiplayer: true, coop: false, singlePlayer: true, pvp: false, mmo: false, achievements: false }, releasedAt: null, tagIds: [], headerArt: null },
} });
const alive = getMode('alive-and-kicking'), everyone = getMode('everyone-owns-it');

beforeEach(() => {
  vi.clearAllMocks();
  ownLibrary.mockResolvedValue({ candidates: [candidate(1), candidate(2)], members: [me], unavailable: [], playtimeHidden: false });
  friendLibraries.mockResolvedValue([{ steamId: friend, state: 'ok', games: new Map([[1, { n: 'Friend name', p: 0 }]]) }]);
  readQit.mockResolvedValue(new Map());
  readPublic.mockResolvedValue(new Map());
  readLive.mockResolvedValue(new Map());
  refreshLive.mockResolvedValue({ players: new Map(), unresolved: [], fetched: 0 });
});

describe('multiplayer mode scores', () => {
  it.each([['high', 4], ['mid', 2], ['low', 1]] as const)('weights %s activity and emits a structured reason', (band, weight) => {
    const game = candidate(); game.signals.live = { players: 1000, band };
    const score = alive.score(game, ctx);
    expect(score).toEqual({ eligible: true, weight, reasons: [{ code: 'active_now', params: { players: 1000, band } }] });
    expect(renderReason(score.reasons[0])).toContain('1,000');
    expect(alive.emits).toEqual(['active_now']);
  });
  it('keeps missing, no-counter and failed live signals eligible without reasons or a band', () => {
    for (const live of [undefined, { players: null, band: null }, { players: Number.NaN, band: null }]) {
      const game = candidate(); game.signals.live = live;
      expect(alive.score(game, ctx)).toEqual({ eligible: true, weight: 1, reasons: [] });
      expect(roll(alive, [game], ctx, { rng: () => 0 }).picks).toHaveLength(1);
    }
  });
  it('uses the absolute floor and distinguishes zero from no counter', () => {
    const game = candidate(); game.signals.live = { players: 0, band: 'low' };
    expect(alive.score(game, ctx)).toMatchObject({ weight: 1, reasons: [{ params: { players: 0, band: 'low' } }] });
    game.signals.live = { players: 99, band: 'high' };
    expect(alive.score(game, ctx).weight).toBe(1);
  });
  it('requires known multiplayer and automatically excludes non-games in both modes', () => {
    const game = candidate();
    for (const multiplayer of [false, null]) {
      game.signals.store!.flags.multiplayer = multiplayer;
      expect(alive.score(game, ctx).eligible).toBe(false);
    }
    delete game.signals.store;
    expect(alive.score(game, ctx).eligible).toBe(false);
    for (const type of ['software', 'tool', 'dlc']) {
      const nonGame = candidate(); nonGame.signals.store!.type = type;
      nonGame.signals.group = { members: [me, friend].map(steamId => ({ steamId, owns: true, playtimeForever: null })) };
      expect(alive.score(nonGame, ctx).eligible).toBe(false);
      expect(everyone.score(nonGame, groupCtx).eligible).toBe(false);
    }
  });
  it('weights shared ownership uniformly independent of playtime or activity', () => {
    const game = candidate();
    game.signals.group = { members: [me, friend].map(steamId => ({ steamId, owns: true, playtimeForever: null })) };
    const score = everyone.score(game, groupCtx);
    expect(score).toEqual({ eligible: true, weight: 1, reasons: [{ code: 'friends_all_own', params: { count: 2 } }] });
    expect(renderReason(score.reasons[0])).toBe('Both players own it');
    expect(everyone.emits).toEqual(['friends_all_own']);
    game.signals.group.members[1].owns = false;
    expect(everyone.score(game, groupCtx).eligible).toBe(false);
    game.signals.group.members = [{ steamId: me, owns: true, playtimeForever: 0 }];
    expect(everyone.score(game, groupCtx).eligible).toBe(false);
    delete game.signals.group;
    expect(everyone.score(game, groupCtx).eligible).toBe(false);
  });
});

describe('intersection scopes', () => {
  it('uses the merged intersection and preserves requester signals and hidden playtime', async () => {
    const game = candidate(1); game.signals.achievements = { total: 2, unlocked: 1, percent: 50, lockedRare: null, lastUnlockAt: null };
    ownLibrary.mockResolvedValue({ candidates: [game, candidate(2)], members: [me], unavailable: [], playtimeHidden: true });
    const result = await friendsScope.resolve({ kind: 'friends', with: [friend, me] }, { steamId: me, now });
    expect(friendLibraries).toHaveBeenCalledWith([friend]);
    expect(result.members).toEqual([me, friend]);
    expect(result.candidates.map(game => game.appid)).toEqual([1]);
    expect(result.candidates[0].signals).toMatchObject({ library: { name: 'Game 1' }, achievements: { percent: 50 }, group: { members: [
      { steamId: me, owns: true, playtimeForever: null }, { steamId: friend, owns: true, playtimeForever: 0 },
    ] } });
    expect(result.playtimeHidden).toBe(true);
  });
  it.each(['private', 'error', 'not_found'])('returns no intersection when a selected member is %s', async state => {
    friendLibraries.mockResolvedValue([
      { steamId: friend, state: 'ok', games: new Map([[1, { n: 'Shared' }]]) },
      { steamId: other, state, games: new Map() },
    ]);
    const result = await friendsScope.resolve({ kind: 'friends', with: [friend, other] }, { steamId: me, now });
    expect(result.candidates).toEqual([]);
    expect(result.unavailable).toEqual([{ steamId: other, state }]);
    expect(result.members).toEqual([me, friend]);
  });
  it('previews use only fresh stored libraries and report a cache miss as unavailable', async () => {
    const expiresAt = Timestamp.fromMillis(now + 1), fetchedAt = Timestamp.fromMillis(now - 1000);
    readPublic.mockResolvedValue(new Map([[friend, { state: 'ok', games: '[[1,"Shared","",0,0,null]]', expiresAt, fetchedAt }]]));
    const result = await pairScope.resolve({ kind: 'pair', with: friend }, { steamId: me, now, fetch: false });
    expect(result.candidates).toHaveLength(1);
    expect(friendLibraries).not.toHaveBeenCalled();
    readPublic.mockResolvedValue(new Map());
    const missing = await pairScope.resolve({ kind: 'pair', with: friend }, { steamId: me, now, fetch: false });
    expect(missing.candidates).toEqual([]);
    expect(missing.unavailable).toEqual([{ steamId: friend, state: 'error' }]);
  });
  it('resolves pairs and rejects a requester-only group', async () => {
    expect((await pairScope.resolve({ kind: 'pair', with: friend }, { steamId: me, now })).candidates).toHaveLength(1);
    await expect(pairScope.resolve({ kind: 'pair', with: me }, { steamId: me, now })).rejects.toThrow('another player');
  });
  it('spins the registered group mode, records everyone and excludes a shared non-game', async () => {
    const own = [candidate(1), candidate(2)]; own[1].signals.store!.type = 'software';
    ownLibrary.mockResolvedValue({ candidates: own, members: [me], unavailable: [] });
    friendLibraries.mockResolvedValue([{ steamId: friend, state: 'ok', games: new Map([[1, { n: 'Shared' }], [2, { n: 'Tool' }]]) }]);
    const recordRoll = vi.fn().mockResolvedValue('roll');
    const deps: PipelineDeps = { resolvers: { friends: friendsScope }, loaders: {}, recordRoll,
      headerArt: async () => null, thresholds: THRESHOLDS, now: () => now, randomSeed: () => 'seed', logError: vi.fn() };
    const result = await runSpin(me, { mode: everyone, scope: groupCtx.scope, filters: [], selections: [], exclude: [], showNonGames: false }, deps);
    expect(result.card).toMatchObject({ appid: 1, reasons: [{ code: 'friends_all_own', params: { count: 2 } }] });
    expect(result.poolSize).toBe(1);
    expect(recordRoll).toHaveBeenCalledWith(me, expect.objectContaining({ participants: [me, friend] }), now);
  });
});

describe('live signal enrichment', () => {
  const loadCtx = { steamId: me, scope: { kind: 'library' as const }, now, filters: [], fetch: true };
  it('combines cached and refreshed counts for relative quartiles with the floor and no-counter case', async () => {
    const games = [1, 2, 3, 4, 5, 6].map(candidate);
    readLive.mockResolvedValue(new Map([[1, { players: 0, expiresAt: Timestamp.fromMillis(now + 1) }]]));
    refreshLive.mockResolvedValue({ players: new Map([[2, 100], [3, 200], [4, 300], [5, 400], [6, null]]) });
    await loadLive(games, loadCtx);
    expect(games.map(game => game.signals.live)).toEqual([
      { players: 0, band: 'low' }, { players: 100, band: 'low' }, { players: 200, band: 'mid' },
      { players: 300, band: 'high' }, { players: 400, band: 'high' }, { players: null, band: null },
    ]);
    expect(refreshLive).toHaveBeenCalledWith([2, 3, 4, 5, 6], { now });
  });
  it('bounds refresh to 40 games and cache reads to 1000; unresolved games remain eligible', async () => {
    const games = Array.from({ length: 1100 }, (_, i) => candidate(i + 1));
    await loadLive(games, loadCtx);
    expect(readLive.mock.calls[0][0]).toHaveLength(1000);
    expect(refreshLive.mock.calls[0][0]).toHaveLength(40);
    expect(alive.score(games[1099], ctx)).toMatchObject({ eligible: true, weight: 1, reasons: [] });
  });
  it('previews read fresh cache only and do not call Steam', async () => {
    const games = [candidate(1), candidate(2)];
    readLive.mockResolvedValue(new Map([
      [1, { players: 100, expiresAt: Timestamp.fromMillis(now + 1) }],
      [2, { players: 999, expiresAt: Timestamp.fromMillis(now) }],
    ]));
    await loadLive(games, { ...loadCtx, fetch: false });
    expect(refreshLive).not.toHaveBeenCalled();
    expect(games[0].signals.live).toEqual({ players: 100, band: 'high' });
    expect(games[1].signals.live).toBeUndefined();
  });
});
