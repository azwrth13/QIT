import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORE_FLAG_BITS } from '../src/lib/apps/metadata';
import { buildCard } from '../src/lib/roulette/card';
import { runPoolPreview, runSpin, SpinInputError, coverageOf, sourcedFamilies, type PipelineDeps, type SignalLoader, type SpinScopeResult } from '../src/lib/roulette/pipeline';
import { MAX_EXCLUDE, parseScope, parseSpinRequest, type ParsedSpinRequest } from '../src/lib/roulette/request';
import { candidateFromGame, candidateFromIndexEntry, INDEXED_NON_GAME_TYPE, storeSignalsFromBits } from '../src/lib/roulette/scopes/library';
import { THRESHOLDS } from '../src/lib/roulette/thresholds';
import type { Candidate, Mode, ScopeResolver, SignalFamily } from '../src/lib/roulette/types';

const { getSteamId, spin, previewPool, enrichLibraryFlags, getAppMeta, readLibIndex, readExclusions, recentlyRolled } = vi.hoisted(() => ({
  getSteamId: vi.fn(), spin: vi.fn(), previewPool: vi.fn(),
  enrichLibraryFlags: vi.fn(), getAppMeta: vi.fn(), readLibIndex: vi.fn(), readExclusions: vi.fn(), recentlyRolled: vi.fn(),
}));
vi.mock('../src/lib/auth', () => ({ getSteamId }));
vi.mock('../src/lib/roulette/service', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/roulette/service')>(), spin, previewPool,
}));
vi.mock('../src/lib/apps/metadata', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/apps/metadata')>(), enrichLibraryFlags, getAppMeta,
}));
vi.mock('../src/lib/store/lib-index', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/store/lib-index')>(), readLibIndex,
}));
vi.mock('../src/lib/history/exclusions', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/history/exclusions')>(), readExclusions,
}));
vi.mock('../src/lib/history/rolls', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/history/rolls')>(), recentlyRolled,
}));

import { POST as spinRoute } from '../src/app/api/roulette/spin/route';
import { POST as poolRoute } from '../src/app/api/roulette/pool/route';
import { GET as modesRoute } from '../src/app/api/roulette/modes/route';
import { historyWindowDays, SIGNAL_LOADERS, STORE_ENRICH_MAX_APPS, STORE_ENRICH_MAX_READS } from '../src/lib/roulette/enrich';
import { modesCatalog, SOURCED_FAMILIES } from '../src/lib/roulette/service';
import { parseFilterSelections } from '../src/lib/roulette/filter-engine';

const steamId = '76561198000000042';
const NOW = Date.parse('2026-09-29T12:00:00Z');
const NOW_S = NOW / 1000;
const DAY_S = 86_400;
const KNOWN = STORE_FLAG_BITS.known;

const parse = (raw: unknown, kind: 'spin' | 'pool' = 'spin', sourced: ReadonlySet<SignalFamily> = SOURCED_FAMILIES): ParsedSpinRequest => {
  const result = parseSpinRequest(raw, kind, sourced);
  if (!result.ok) throw new Error(result.error);
  return result.request;
};

// --- request parsing ---------------------------------------------------------------------------------------------

describe('parseSpinRequest', () => {
  it('accepts a minimal spin and defaults to the own library', () => {
    const request = parse({ mode: 'pure-random' });
    expect(request.mode?.id).toBe('pure-random');
    expect(request).toMatchObject({ filters: [], selections: [], scope: { kind: 'library' }, exclude: [], showNonGames: false });
    expect(request.seed).toBeUndefined();
    expect(request.sessionId).toBeUndefined();
  });

  it('reads every field and normalises filters for storage', () => {
    const request = parse({
      mode: 'pure-random', scope: { kind: 'library' }, exclude: [620, 620, 440], showNonGames: true, sessionId: 'picker_1', seed: 'abc',
      filters: [{ id: 'never-played' }, { id: 'playtime', params: { minMinutes: 10 } }, { id: 'exclude-rolled', params: { days: 7 } }],
    });
    expect(request.exclude).toEqual([620, 440]);
    expect(request.selections).toEqual([{ id: 'never-played' }, { id: 'playtime', params: { minMinutes: 10 } }, { id: 'exclude-rolled', params: { days: 7 } }]);
    expect(request).toMatchObject({ showNonGames: true, sessionId: 'picker_1', seed: 'abc' });
  });

  it('rejects anything it does not recognise', () => {
    const bad: unknown[] = [
      null, [], 'spin', {}, { mode: 'nope' }, { mode: 'dust-collector' }, { mode: 'pure-random', extra: 1 },
      { mode: 'pure-random', filters: [{ id: 'installed' }] }, { mode: 'pure-random', filters: [{ id: 'playtime', params: {} }] },
      { mode: 'pure-random', scope: { kind: 'library', with: steamId } }, { mode: 'pure-random', scope: { kind: 'galaxy' } },
      { mode: 'pure-random', exclude: [0] }, { mode: 'pure-random', exclude: ['620'] },
      { mode: 'pure-random', exclude: Array.from({ length: MAX_EXCLUDE + 1 }, (_, i) => i + 1) },
      { mode: 'pure-random', showNonGames: 'yes' }, { mode: 'pure-random', sessionId: 'a/b' }, { mode: 'pure-random', seed: '' },
      { mode: 'pure-random', seed: 'x'.repeat(129) },
    ];
    for (const raw of bad) expect(parseSpinRequest(raw, 'spin', SOURCED_FAMILIES).ok, JSON.stringify(raw)).toBe(false);
  });

  it('lets a pool request omit the mode but not carry a seed', () => {
    expect(parse({}, 'pool').mode).toBeNull();
    expect(parse({ mode: 'pure-random' }, 'pool').mode?.id).toBe('pure-random');
    expect(parseSpinRequest({ seed: 'abc' }, 'pool', SOURCED_FAMILIES).ok).toBe(false);
  });

  it('rejects filters whose signals have no source yet', () => {
    const activity = { id: 'player-activity', params: { mode: 'active' } };
    for (const filter of [activity, { id: 'shared-with-friends', params: {} }]) {
      expect(parseSpinRequest({ mode: 'pure-random', filters: [filter] }, 'spin', SOURCED_FAMILIES)).toEqual({ ok: false, error: `filter ${filter.id} is not available` });
    }
    expect(parse({ filters: [activity] }, 'pool', new Set<SignalFamily>(['library', 'live'])).filters[0].filter.id).toBe('player-activity');
  });

  it('validates every scope shape', () => {
    const friend = '76561198000000043';
    expect(parseScope(undefined)).toEqual({ kind: 'library' });
    expect(parseScope({ kind: 'friends', with: [friend] })).toEqual({ kind: 'friends', with: [friend] });
    expect(parseScope({ kind: 'pair', with: friend })).toEqual({ kind: 'pair', with: friend });
    expect(parseScope({ kind: 'lobby', code: 'ABC123' })).toEqual({ kind: 'lobby', code: 'ABC123' });
    expect(parseScope({ kind: 'appids', appids: [620, 620, 440] })).toEqual({ kind: 'appids', appids: [620, 440] });
    for (const bad of [
      { kind: 'friends', with: [] }, { kind: 'friends', with: [friend, friend] }, { kind: 'friends', with: ['1'] },
      { kind: 'friends', with: Array.from({ length: 17 }, (_, i) => `765611980000001${String(i).padStart(2, '0')}`) },
      { kind: 'pair', with: 'x' }, { kind: 'lobby', code: '../x' }, { kind: 'appids', appids: [] }, { kind: 'appids', appids: [1.5] },
      { kind: 'lobby', code: 'ABC', extra: true }, 'library',
    ]) expect(parseScope(bad), JSON.stringify(bad)).toBeNull();
  });
});

// --- candidates from the library index ---------------------------------------------------------------------------

describe('library scope candidates', () => {
  it('maps index fields to signals, leaving unknown families out', () => {
    const candidate = candidateFromIndexEntry(620, { n: 'Portal 2', i: 'a'.repeat(40), p: 125, w: 5, r: 1_700_000_000 });
    expect(candidate).toEqual({
      appid: 620,
      signals: { library: { name: 'Portal 2', iconHash: 'a'.repeat(40), playtimeForever: 125, playtime2Weeks: 5, lastPlayedAt: 1_700_000_000 } },
    });
    const bare = candidateFromIndexEntry(10, { n: 'Counter-Strike', p: 30 });
    expect(bare.signals.library).toEqual({ name: 'Counter-Strike', iconHash: null, playtimeForever: 30, playtime2Weeks: null, lastPlayedAt: null });
    expect(candidateFromIndexEntry(20, { n: 'Never', p: 0, r: 0 }).signals.library.lastPlayedAt).toBe(0);
  });

  it('decodes store flag bits, keeping unknown flags unknown', () => {
    const coop = candidateFromIndexEntry(1, { n: 'A', f: KNOWN | STORE_FLAG_BITS.coop | STORE_FLAG_BITS.multiplayer });
    expect(coop.signals.store).toMatchObject({ type: null, flags: { coop: true, multiplayer: true, singlePlayer: false } });
    expect(candidateFromIndexEntry(2, { n: 'B', f: 0 }).signals.store?.flags.coop).toBeNull();
    expect(storeSignalsFromBits(STORE_FLAG_BITS.nonGame).type).toBe(INDEXED_NON_GAME_TYPE);
  });

  it('reads the achievement summary when the index has one', () => {
    expect(candidateFromIndexEntry(1, { n: 'A', at: 40, au: 10, ap: 25 }).signals.achievements).toEqual({
      total: 40, unlocked: 10, percent: 25, lockedRare: null, lastUnlockAt: null,
    });
    expect(candidateFromIndexEntry(1, { n: 'A', at: 40, au: 10 }).signals.achievements?.percent).toBe(25);
    expect(candidateFromIndexEntry(1, { n: 'A', at: 0 }).signals.achievements).toBeNull();
    expect('achievements' in candidateFromIndexEntry(1, { n: 'A', at: 40 }).signals).toBe(false);
  });

  it('builds library signals from a legacy per-game document', () => {
    expect(candidateFromGame({ appid: 620, name: 'Portal 2', playtime_forever: 60, rtime_last_played: null }).signals.library).toEqual({
      name: 'Portal 2', iconHash: null, playtimeForever: 60, playtime2Weeks: null, lastPlayedAt: null,
    });
  });
});

// --- the pipeline with plain-data deps ---------------------------------------------------------------------------

type Game = { appid: number; name?: string; p?: number; f?: number; excluded?: 'day' | 'forever'; rolledAt?: number };

function fixture(games: Game[], { playtimeHidden = false, headerArt = 'https://art.test/header.jpg' as string | null } = {}) {
  const recordRoll = vi.fn<PipelineDeps['recordRoll']>(async () => 'roll-1');
  const loaded: Record<string, number[][]> = {};
  const track = (family: string, fill: (candidate: Candidate, game: Game) => void): SignalLoader => async (candidates, ctx) => {
    (loaded[family] ??= []).push(candidates.map(candidate => candidate.appid));
    loadCtx.push(ctx);
    for (const candidate of candidates) fill(candidate, games.find(game => game.appid === candidate.appid)!);
  };
  const loadCtx: Parameters<SignalLoader>[1][] = [];
  const resolver: ScopeResolver<'library'> = {
    kind: 'library',
    resolve: async (): Promise<SpinScopeResult> => ({
      candidates: games.map(game => ({
        appid: game.appid,
        signals: { library: { name: game.name ?? `Game ${game.appid}`, iconHash: null, playtimeForever: game.p ?? 0, playtime2Weeks: 0, lastPlayedAt: null } },
      })),
      members: [steamId], unavailable: [], playtimeHidden,
    }),
  };
  const deps: PipelineDeps = {
    resolvers: { library: resolver },
    loaders: {
      history: track('history', (candidate, game) => {
        candidate.signals.history = { timesRolled: game.rolledAt ? 1 : 0, lastRolledAt: game.rolledAt ?? null, excluded: game.excluded ?? null, playedAfterRoll: false };
      }),
      store: track('store', (candidate, game) => { if (game.f !== undefined) candidate.signals.store = storeSignalsFromBits(game.f); }),
      achievements: track('achievements', () => {}),
    },
    recordRoll,
    headerArt: vi.fn(async () => headerArt),
    thresholds: THRESHOLDS,
    now: () => NOW,
    randomSeed: () => 'fixed-seed',
    logError: vi.fn(),
  };
  return { deps, recordRoll, loaded, loadCtx };
}

const games: Game[] = [
  { appid: 10, p: 0, f: KNOWN },
  { appid: 20, p: 300, f: KNOWN | STORE_FLAG_BITS.coop | STORE_FLAG_BITS.multiplayer },
  { appid: 30, p: 0, f: STORE_FLAG_BITS.nonGame },
  { appid: 40, p: 0, f: KNOWN, excluded: 'forever' },
  { appid: 50, p: 45 },
];

describe('runSpin', () => {
  it('draws Pure Random from the pool, records the roll and builds the card', async () => {
    const { deps, recordRoll } = fixture(games);
    const result = await runSpin(steamId, parse({ mode: 'pure-random', filters: [{ id: 'never-played' }] }), deps);
    // 30 is a non-game, 40 is vetoed, 20 and 50 have playtime.
    expect(result.card?.appid).toBe(10);
    expect(result).toMatchObject({ poolSize: 1, eligible: 1, seed: 'fixed-seed', playtimeHidden: false });
    expect(result.preview).toMatchObject({ total: 5, removed: { request: 0, vetoed: 1, non_game: 1 }, afterExclusions: 3, final: 1 });
    expect(result.card).toEqual({
      appid: 10, name: 'Game 10', modeId: 'pure-random', rollId: 'roll-1',
      art: { header: 'https://art.test/header.jpg', icon: null }, reasons: [{ code: 'random_pick', params: {} }],
      playtimeForever: 0, lastPlayedAt: null, achievements: null, live: null, friends: null, previousSelections: 0,
      storeUrl: 'https://store.steampowered.com/app/10', launchUrl: 'steam://run/10',
    });
    expect(recordRoll).toHaveBeenCalledWith(steamId, {
      appid: 10, name: 'Game 10', modeId: 'pure-random', filters: [{ id: 'never-played' }], scope: { kind: 'library' },
      participants: [steamId], playtimeAtRoll: 0, reasons: [{ code: 'random_pick', params: {} }],
    }, NOW);
  });

  it('never draws excluded games, and replays a seed exactly', async () => {
    const { deps } = fixture(games);
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const result = await runSpin(steamId, parse({ mode: 'pure-random', seed: `s${i}`, exclude: [50] }), deps);
      seen.add(result.card!.appid);
      const again = await runSpin(steamId, parse({ mode: 'pure-random', seed: `s${i}`, exclude: [50] }), deps);
      expect(again.card!.appid).toBe(result.card!.appid);
    }
    expect([...seen].sort()).toEqual([10, 20]);
  });

  it('keeps non-games when asked', async () => {
    const { deps } = fixture(games);
    const result = await runSpin(steamId, parse({ mode: 'pure-random', showNonGames: true }), deps);
    expect(result.preview.removed.non_game).toBe(0);
    expect(result.poolSize).toBe(4);
  });

  it('leaves games with unknown store data out of a store filter and reports coverage', async () => {
    const { deps } = fixture(games);
    const result = await runSpin(steamId, parse({ mode: 'pure-random', filters: [{ id: 'co-op' }] }), deps);
    expect(result.card?.appid).toBe(20);
    expect(result.preview.steps).toEqual([{ id: 'co-op', passed: 1, failed: 1, unknown: 1, remaining: 1 }]);
    expect(result.coverage).toEqual({ library: 1, store: 0.8, history: 1 });
  });

  it('returns no card and records nothing when the pool is empty', async () => {
    const { deps, recordRoll } = fixture(games);
    const result = await runSpin(steamId, parse({ mode: 'pure-random', exclude: [10, 20, 50] }), deps);
    expect(result).toMatchObject({ card: null, poolSize: 0, eligible: 0 });
    expect(recordRoll).not.toHaveBeenCalled();
    const empty = await runSpin(steamId, parse({ mode: 'pure-random' }), fixture([]).deps);
    expect(empty).toMatchObject({ card: null, poolSize: 0, coverage: { library: 1, store: 1, history: 1 } });
  });

  it('still returns the card when the roll cannot be stored or the art lookup fails', async () => {
    const { deps, recordRoll } = fixture(games);
    recordRoll.mockRejectedValueOnce(new Error('firestore down'));
    vi.mocked(deps.headerArt).mockRejectedValueOnce(new Error('steam down'));
    const result = await runSpin(steamId, parse({ mode: 'pure-random', exclude: [20, 50] }), deps);
    expect(result.card).toMatchObject({ appid: 10, rollId: null, art: { header: null } });
    expect(deps.logError).toHaveBeenCalledTimes(2);
  });

  it('prefers header art already on the signals', async () => {
    const { deps } = fixture([{ appid: 10, f: KNOWN }]);
    deps.loaders.store = async candidates => { candidates[0].signals.store = { ...storeSignalsFromBits(KNOWN), headerArt: 'https://art.test/own.jpg' }; };
    const result = await runSpin(steamId, parse({ mode: 'pure-random' }), deps);
    expect(result.card?.art.header).toBe('https://art.test/own.jpg');
    expect(deps.headerArt).not.toHaveBeenCalled();
  });

  it('loads what the stages read for the whole scope, and mode-only signals for the filtered pool', async () => {
    const { deps, loaded, loadCtx } = fixture(games);
    const mode: Mode = {
      id: 'pure-random', label: 'Test', description: '', requires: ['library', 'achievements'], emits: ['random_pick'],
      scopes: ['library'], stub: false, score: () => ({ eligible: true, weight: 1, reasons: [] }),
    };
    const request = { ...parse({ mode: 'pure-random', filters: [{ id: 'never-played' }], sessionId: 'sess' }), mode };
    const result = await runSpin(steamId, request, deps);
    expect(loaded.history).toEqual([[10, 20, 30, 40, 50]]);
    expect(loaded.store).toEqual([[10, 20, 30, 40, 50]]);
    expect(loaded.achievements).toEqual([[10]]);
    expect(loadCtx[0]).toMatchObject({ steamId, scope: { kind: 'library' }, now: NOW, sessionId: 'sess', fetch: true });
    expect(Object.keys(result.coverage)).toEqual(['library', 'store', 'achievements', 'history']);
    expect(result.coverage.achievements).toBe(0);
  });

  it('stores unknown playtime and refuses playtime filters when Steam hides playtime', async () => {
    const { deps, recordRoll } = fixture(games, { playtimeHidden: true });
    const result = await runSpin(steamId, parse({ mode: 'pure-random', exclude: [20, 50] }), deps);
    expect(result.playtimeHidden).toBe(true);
    expect(recordRoll.mock.calls[0][1]).toMatchObject({ playtimeAtRoll: null });
    for (const id of ['never-played', 'playtime', 'recently-played', 'not-recently-played']) {
      const params = id === 'playtime' ? { minMinutes: 1 } : undefined;
      await expect(runSpin(steamId, parse({ mode: 'pure-random', filters: [{ id, params }] }), deps)).rejects.toBeInstanceOf(SpinInputError);
    }
  });

  it('rejects a scope with no resolver yet', async () => {
    const { deps } = fixture(games);
    await expect(runSpin(steamId, parse({ mode: 'pure-random', scope: { kind: 'pair', with: '76561198000000043' } }), deps))
      .rejects.toThrow('scope pair is not available yet');
  });

  it('rejects a filter whose signals the scope cannot source, and accepts it once a resolver attaches them', async () => {
    const { deps } = fixture(games);
    const request = parse({ mode: 'pure-random', filters: [{ id: 'player-activity', params: { mode: 'active' } }] }, 'spin', new Set<SignalFamily>(['library', 'live']));
    await expect(runSpin(steamId, request, deps)).rejects.toThrow('filter player-activity is not available for scope library');
    await expect(runPoolPreview(steamId, request, deps)).rejects.toBeInstanceOf(SpinInputError);
    deps.resolvers.library = { ...deps.resolvers.library!, provides: ['live'] };
    expect(sourcedFamilies(deps, 'library').has('live')).toBe(true);
    await expect(runPoolPreview(steamId, request, deps)).resolves.toMatchObject({ coverage: { live: 0 } });
  });
});

describe('runPoolPreview', () => {
  it('counts the pool from stored data only and scores the mode when one is named', async () => {
    const { deps, recordRoll, loadCtx } = fixture(games);
    const result = await runPoolPreview(steamId, parse({ mode: 'pure-random', filters: [{ id: 'never-played' }] }, 'pool'), deps);
    expect(result).toMatchObject({ eligible: 1, playtimeHidden: false, preview: { total: 5, final: 1 }, coverage: { library: 1, store: 0.8, history: 1 } });
    expect(loadCtx.every(ctx => ctx.fetch === false)).toBe(true);
    expect(recordRoll).not.toHaveBeenCalled();
    expect((await runPoolPreview(steamId, parse({}, 'pool'), deps)).eligible).toBeNull();
  });
});

describe('coverageOf and buildCard', () => {
  it('reports 1 for an empty list and rounds shares', () => {
    const c = (appid: number, withStore: boolean): Candidate => ({
      appid, signals: { library: { name: '', iconHash: null, playtimeForever: 0, playtime2Weeks: null, lastPlayedAt: null }, ...(withStore ? { store: storeSignalsFromBits(0) } : {}) },
    });
    expect(coverageOf([], ['store'])).toEqual({ store: 1 });
    expect(coverageOf([c(1, true), c(2, false), c(3, false)], ['library', 'store'])).toEqual({ library: 1, store: 0.3333 });
  });

  it('shows at most three reasons, the achievement summary and previous selections', () => {
    const card = buildCard({
      weight: 1,
      reasons: [
        { code: 'never_launched', params: {} }, { code: 'idle', params: { months: 3 } }, { code: 'not_rolled_recently', params: {} },
        { code: 'random_pick', params: {} },
      ],
      candidate: {
        appid: 620,
        signals: {
          library: { name: 'Portal 2', iconHash: 'b'.repeat(40), playtimeForever: 5, playtime2Weeks: 0, lastPlayedAt: 99 },
          achievements: { total: 51, unlocked: 3, percent: 5.9, lockedRare: null, lastUnlockAt: null },
          history: { timesRolled: 2, lastRolledAt: 1, excluded: null, playedAfterRoll: false },
        },
      },
    }, { modeId: 'pure-random', rollId: 'r', header: null });
    expect(card.reasons).toHaveLength(3);
    expect(card.achievements).toEqual({ unlocked: 3, total: 51, percent: 5.9 });
    expect(card.previousSelections).toBe(2);
    expect(card.art.icon).toBe(`https://media.steampowered.com/steamcommunity/public/images/apps/620/${'b'.repeat(40)}.jpg`);
  });
});

// --- signal loaders ----------------------------------------------------------------------------------------------

describe('signal loaders', () => {
  const candidate = (appid: number, f?: number): Candidate => ({
    appid, signals: { library: { name: '', iconHash: null, playtimeForever: 0, playtime2Weeks: null, lastPlayedAt: null }, ...(f === undefined ? {} : { store: storeSignalsFromBits(f) }) },
  });
  const ctx = (overrides: Partial<Parameters<SignalLoader>[1]> = {}): Parameters<SignalLoader>[1] => ({
    steamId, scope: { kind: 'library' }, now: NOW, filters: [], fetch: true, ...overrides,
  });
  const filters = (raw: unknown) => { const parsed = parseFilterSelections(raw); if (!parsed.ok) throw new Error(parsed.error); return parsed.filters; };

  beforeEach(() => {
    for (const mock of [enrichLibraryFlags, getAppMeta, readLibIndex, readExclusions, recentlyRolled]) mock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('widens the history window only for a longer anti-repeat filter', () => {
    expect(historyWindowDays(ctx())).toBe(THRESHOLDS.antiRepeatDays);
    expect(historyWindowDays(ctx({ filters: filters([{ id: 'exclude-rolled', params: { days: 7 } }]) }))).toBe(THRESHOLDS.antiRepeatDays);
    expect(historyWindowDays(ctx({ filters: filters([{ id: 'exclude-rolled', params: { days: 90 } }]) }))).toBe(90);
  });

  it('attaches exclusions and recent rolls to every candidate', async () => {
    readExclusions.mockResolvedValue(new Map([[20, { appid: 20, scope: 'day' }]]));
    recentlyRolled.mockResolvedValue(new Map([[10, { count: 2, lastRolledAt: NOW_S - DAY_S }]]));
    const pool = [candidate(10), candidate(20)];
    await SIGNAL_LOADERS.history!(pool, ctx({ sessionId: 'sess' }));
    expect(readExclusions).toHaveBeenCalledWith(steamId, { sessionId: 'sess', now: NOW });
    expect(recentlyRolled).toHaveBeenCalledWith(steamId, { days: 30, now: NOW });
    expect(pool.map(c => c.signals.history)).toEqual([
      { timesRolled: 2, lastRolledAt: NOW_S - DAY_S, excluded: null, playedAfterRoll: false },
      { timesRolled: 0, lastRolledAt: null, excluded: 'day', playedAfterRoll: false },
    ]);
  });

  it('fills missing store flags through the library index, bounded, and only when fetching', async () => {
    readLibIndex.mockResolvedValue({ entries: new Map([[10, { n: 'A', f: KNOWN | STORE_FLAG_BITS.coop }], [20, { n: 'B' }]]), built: true, updatedAt: null });
    const pool = [candidate(10), candidate(20), candidate(30, KNOWN)];
    await SIGNAL_LOADERS.store!(pool, ctx({ fetch: false }));
    expect(enrichLibraryFlags).not.toHaveBeenCalled();
    await SIGNAL_LOADERS.store!(pool, ctx());
    expect(enrichLibraryFlags).toHaveBeenCalledWith(steamId, { appids: [10, 20], maxFetch: STORE_ENRICH_MAX_APPS });
    expect(STORE_ENRICH_MAX_APPS).toBeLessThanOrEqual(500);
    expect(pool[0].signals.store?.flags.coop).toBe(true);
    expect(pool[1].signals.store).toBeUndefined();
    enrichLibraryFlags.mockClear();
    await SIGNAL_LOADERS.store!([candidate(30, KNOWN)], ctx());
    expect(enrichLibraryFlags).not.toHaveBeenCalled();
  });

  it('reads a bounded number of games per spin, most played first', async () => {
    readLibIndex.mockResolvedValue({ entries: new Map(), built: true, updatedAt: null });
    const pool = Array.from({ length: STORE_ENRICH_MAX_READS + 5 }, (_, i) => {
      const game = candidate(i + 1);
      game.signals.library.playtimeForever = i === 3 ? 10_000 : i;
      return game;
    });
    await SIGNAL_LOADERS.store!(pool, ctx());
    const { appids } = enrichLibraryFlags.mock.calls[0][1];
    expect(appids).toHaveLength(STORE_ENRICH_MAX_READS);
    expect(appids.slice(0, 2)).toEqual([4, STORE_ENRICH_MAX_READS + 5]);
    expect(appids).not.toContain(1);
  });

  it('uses the metadata cache for other scopes and never fails the spin over store data', async () => {
    getAppMeta.mockResolvedValue({ meta: new Map([[10, { appid: 10, state: 'ok', type: 'dlc', flags: KNOWN, fetchedAt: new Date(), stale: false }]]), unresolved: [], fetched: 0 });
    const pool = [candidate(10)];
    await SIGNAL_LOADERS.store!(pool, ctx({ scope: { kind: 'appids', appids: [10] } }));
    expect(pool[0].signals.store?.type).toBe('dlc');
    enrichLibraryFlags.mockRejectedValue(new Error('down'));
    await expect(SIGNAL_LOADERS.store!([candidate(10)], ctx())).resolves.toBeUndefined();
  });
});

// --- routes ------------------------------------------------------------------------------------------------------

describe('/api/roulette routes', () => {
  let ip = 0;
  const headers = (extra: Record<string, string> = {}) => ({ 'x-forwarded-for': `198.51.100.${++ip % 250}`, ...extra });
  const post = (route: typeof spinRoute, path: string, body: unknown, extra: Record<string, string> = { origin: 'https://qit.test' }) =>
    route(new Request(`https://qit.test/api/roulette/${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: headers(extra) }));

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.test');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const mock of [getSteamId, spin, previewPool]) mock.mockReset();
    getSteamId.mockResolvedValue(steamId);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('requires a session', async () => {
    getSteamId.mockResolvedValue(null);
    const responses = [
      await post(spinRoute, 'spin', { mode: 'pure-random' }), await post(poolRoute, 'pool', {}),
      await modesRoute(new Request('https://qit.test/api/roulette/modes', { headers: headers() })),
    ];
    expect(responses.map(r => r.status)).toEqual([401, 401, 401]);
    expect(spin).not.toHaveBeenCalled();
  });

  it('rejects cross-site posts and invalid bodies before running the pipeline', async () => {
    expect((await post(spinRoute, 'spin', { mode: 'pure-random' }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await post(poolRoute, 'pool', {}, {})).status).toBe(403);
    expect((await post(spinRoute, 'spin', '{nope')).status).toBe(400);
    const invalid = await post(spinRoute, 'spin', { mode: 'dust-collector' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: 'invalid', message: 'mode dust-collector is not available' } });
    expect((await post(spinRoute, 'spin', { mode: 'pure-random', exclude: 'x'.repeat(17 * 1024) })).status).toBe(413);
    expect(spin).not.toHaveBeenCalled();
  });

  it('spins for the session user', async () => {
    spin.mockResolvedValue({ card: null, poolSize: 0, coverage: {}, seed: 's', eligible: 0, preview: {}, playtimeHidden: false });
    const response = await post(spinRoute, 'spin', { mode: 'pure-random', seed: 's' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ card: null, seed: 's' });
    expect(spin.mock.calls[0][0]).toBe(steamId);
    expect(spin.mock.calls[0][1]).toMatchObject({ scope: { kind: 'library' }, seed: 's' });
  });

  it('maps input errors to 400 and failures to 502 without leaking details', async () => {
    spin.mockRejectedValueOnce(new SpinInputError('scope pair is not available yet'));
    expect((await post(spinRoute, 'spin', { mode: 'pure-random' })).status).toBe(400);
    spin.mockRejectedValueOnce(new Error('secret detail'));
    const failed = await post(spinRoute, 'spin', { mode: 'pure-random' });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain('secret');
    previewPool.mockRejectedValueOnce(new Error('secret detail'));
    expect((await post(poolRoute, 'pool', {})).status).toBe(502);
  });

  it('previews the pool', async () => {
    previewPool.mockResolvedValue({ preview: { total: 3 }, coverage: {}, eligible: null, playtimeHidden: false });
    const response = await post(poolRoute, 'pool', { filters: [{ id: 'never-played' }] });
    expect(response.status).toBe(200);
    expect((await response.json()).preview.total).toBe(3);
    expect((await post(poolRoute, 'pool', { seed: 'x' })).status).toBe(400);
  });

  it('rate limits spins per user', async () => {
    spin.mockResolvedValue({ card: null });
    getSteamId.mockResolvedValue('76561198000000099');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post(spinRoute, 'spin', { mode: 'pure-random' })).status);
    expect(statuses.slice(0, 10).every(status => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('lists only implemented modes and filters, and the resolvable scopes', async () => {
    const response = await modesRoute(new Request('https://qit.test/api/roulette/modes', { headers: headers() }));
    const body = await response.json();
    expect(body).toEqual(modesCatalog());
    expect(body.modes).toEqual([{ id: 'pure-random', label: 'Pure Random', description: 'Any eligible game, each equally likely.', requires: ['library'], scopes: ['library'] }]);
    expect(body.scopes).toEqual(['library']);
    expect(body.filters.map((f: { id: string }) => f.id)).toContain('never-played');
    expect(body.filters.map((f: { id: string }) => f.id)).not.toContain('installed');
    expect(body.filters.map((f: { id: string }) => f.id)).not.toContain('player-activity');
    expect(body.filters.map((f: { id: string }) => f.id)).not.toContain('shared-with-friends');
    expect(body.filters).toHaveLength(9);
  });

  it('offers a filter once its signals have a source', () => {
    const catalog = modesCatalog({ resolvers: { library: { kind: 'library', provides: ['live'], resolve: async () => ({ candidates: [], members: [], unavailable: [] }) } }, loaders: {} });
    const ids = catalog.filters.map(filter => filter.id);
    expect(ids).toContain('player-activity');
    expect(ids).not.toContain('co-op');
    expect(ids).not.toContain('exclude-rolled');
  });
});
