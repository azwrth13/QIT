import { describe, expect, it, vi } from 'vitest';
import {
  buildBacklogReasons,
  getBacklogOverview,
  modeForCategory,
  spinBacklog,
  type BacklogDeps,
} from '../src/lib/backlog/service';
import { THRESHOLDS } from '../src/lib/roulette/thresholds';
import type { Candidate } from '../src/lib/roulette/types';

const NOW_SECONDS = 1_790_000_000;
const NOW_MS = NOW_SECONDS * 1000;
const DAY = 86_400;

function createCandidate(
  appid: number,
  name: string,
  playtimeForever: number,
  idleDays: number | null = null,
  achievements?: { unlocked: number; total: number; percent: number } | null,
  type: string | null = null,
): Candidate {
  return {
    appid,
    signals: {
      library: {
        name,
        iconHash: 'hash_' + appid,
        playtimeForever,
        playtime2Weeks: 0,
        lastPlayedAt: idleDays !== null ? NOW_SECONDS - idleDays * DAY : null,
      },
      store: type ? { type, flags: { multiplayer: null, coop: null, singlePlayer: null, pvp: null, mmo: null, achievements: null }, releasedAt: null, tagIds: [], headerArt: null } : undefined,
      achievements: achievements !== undefined ? (achievements ? { ...achievements, lockedRare: null, lastUnlockAt: null } : null) : undefined,
    },
  };
}

function mockDeps(overrides: Partial<BacklogDeps> = {}): BacklogDeps {
  return {
    getCandidates: vi.fn().mockResolvedValue({
      candidates: [
        createCandidate(1, 'Never Played Game', 0),
        createCandidate(2, 'Barely Played Game', 45, 10),
        createCandidate(3, 'Idle Game', 1500, 200),
        createCandidate(4, 'Abandoned Game', 120, 100),
        createCandidate(5, 'Low Ach Game', 600, 10, { unlocked: 5, total: 20, percent: 25 }),
        createCandidate(6, 'High Ach Game', 1200, 15, { unlocked: 18, total: 20, percent: 90 }),
        createCandidate(7, 'Completed Game', 800, 5, { unlocked: 20, total: 20, percent: 100 }),
        createCandidate(8, 'Tool Software', 0, null, null, 'application'),
      ],
      playtimeHidden: false,
      built: true,
    }),
    getExclusions: vi.fn().mockResolvedValue(new Set<number>()),
    recordRoll: vi.fn().mockResolvedValue('roll_123'),
    headerArt: vi.fn().mockResolvedValue('https://art.test/header.jpg'),
    thresholds: THRESHOLDS,
    now: () => NOW_MS,
    randomSeed: () => 'fixed_seed',
    logError: vi.fn(),
    ...overrides,
  };
}

describe('backlog service overview', () => {
  it('categorizes games correctly across all six categories and excludes non-games', async () => {
    const deps = mockDeps();
    const overview = await getBacklogOverview('user1', deps);

    expect(overview.totalGames).toBe(8);
    expect(overview.playtimeHidden).toBe(false);
    expect(overview.libraryBuilt).toBe(true);

    const never = overview.categories['never-played'];
    expect(never.count).toBe(1);
    expect(never.games[0].appid).toBe(1);
    expect(never.status).toBe('ready');

    const barely = overview.categories['barely-played'];
    expect(barely.count).toBe(1);
    expect(barely.games[0].appid).toBe(2);

    const idle = overview.categories['not-played-in-a-long-time'];
    expect(idle.count).toBe(2);
    expect(idle.games.map(g => g.appid)).toEqual([3, 4]);

    const abandoned = overview.categories['started-but-abandoned'];
    expect(abandoned.count).toBe(1);
    expect(abandoned.games[0].appid).toBe(4);

    const lowAch = overview.categories['low-completion'];
    expect(lowAch.count).toBe(1);
    expect(lowAch.games[0].appid).toBe(5);

    const highAch = overview.categories['high-completion-but-unfinished'];
    expect(highAch.count).toBe(1);
    expect(highAch.games[0].appid).toBe(6);

    // Completed game (appid 7) should not appear in high-completion-but-unfinished
    expect(highAch.games.some(g => g.appid === 7)).toBe(false);
    // Non-game application (appid 8) should not appear in any category
    for (const cat of Object.values(overview.categories)) {
      expect(cat.games.some(g => g.appid === 8)).toBe(false);
    }
  });

  it('reports playtime_hidden status when Steam profile hides playtime', async () => {
    const deps = mockDeps({
      getCandidates: vi.fn().mockResolvedValue({
        candidates: [createCandidate(1, 'Game 1', 0), createCandidate(2, 'Game 2', 50)],
        playtimeHidden: true,
        built: true,
      }),
    });
    const overview = await getBacklogOverview('user1', deps);
    expect(overview.playtimeHidden).toBe(true);
    expect(overview.categories['never-played'].status).toBe('playtime_hidden');
    expect(overview.categories['barely-played'].status).toBe('playtime_hidden');
    expect(overview.categories['not-played-in-a-long-time'].status).toBe('playtime_hidden');
    expect(overview.categories['started-but-abandoned'].status).toBe('playtime_hidden');
  });

  it('degrades achievement categories gracefully to scan_required when no achievements are scanned', async () => {
    const deps = mockDeps({
      getCandidates: vi.fn().mockResolvedValue({
        candidates: [
          createCandidate(1, 'Game 1', 100),
          createCandidate(2, 'Game 2', 200),
        ],
        playtimeHidden: false,
        built: true,
      }),
    });
    const overview = await getBacklogOverview('user1', deps);
    expect(overview.scannedGames).toBe(0);
    expect(overview.unscannedGames).toBe(2);
    expect(overview.categories['low-completion'].status).toBe('scan_required');
    expect(overview.categories['high-completion-but-unfinished'].status).toBe('scan_required');
  });

  it('handles empty libraries cleanly', async () => {
    const deps = mockDeps({
      getCandidates: vi.fn().mockResolvedValue({
        candidates: [],
        playtimeHidden: false,
        built: false,
      }),
    });
    const overview = await getBacklogOverview('user1', deps);
    expect(overview.totalGames).toBe(0);
    expect(overview.libraryBuilt).toBe(false);
    for (const cat of Object.values(overview.categories)) {
      expect(cat.count).toBe(0);
      expect(cat.games).toEqual([]);
    }
  });

  it('filters out stored exclusions from category lists and counts', async () => {
    const deps = mockDeps({
      getExclusions: vi.fn().mockResolvedValue(new Set([1, 4])),
    });
    const overview = await getBacklogOverview('user1', deps);

    // Appid 1 was in never-played; now never-played count is 0
    expect(overview.categories['never-played'].count).toBe(0);
    expect(overview.categories['never-played'].games).toEqual([]);

    // Appid 4 was in started-but-abandoned; now count is 0
    expect(overview.categories['started-but-abandoned'].count).toBe(0);
    expect(overview.categories['started-but-abandoned'].games).toEqual([]);

    // Appid 4 was also in not-played-in-a-long-time along with appid 3; now only appid 3 remains
    expect(overview.categories['not-played-in-a-long-time'].count).toBe(1);
    expect(overview.categories['not-played-in-a-long-time'].games.map(g => g.appid)).toEqual([3]);
  });

  it('treats games with null achievements as scanned rather than unscanned', async () => {
    const deps = mockDeps({
      getCandidates: vi.fn().mockResolvedValue({
        candidates: [
          createCandidate(1, 'Game With No Achievements', 100, 10, null),
        ],
        playtimeHidden: false,
        built: true,
      }),
    });
    const overview = await getBacklogOverview('user1', deps);
    expect(overview.scannedGames).toBe(1);
    expect(overview.unscannedGames).toBe(0);
    expect(overview.categories['low-completion'].unscannedCount).toBe(0);
    expect(overview.categories['high-completion-but-unfinished'].unscannedCount).toBe(0);
    expect(overview.categories['low-completion'].status).toBe('ready');
  });

  it('passes sessionId to getExclusions when provided in overview options', async () => {
    const deps = mockDeps();
    await getBacklogOverview('user1', { sessionId: 'sess_abc' }, deps);
    expect(deps.getExclusions).toHaveBeenCalledWith('user1', NOW_MS, 'sess_abc');
  });
});

describe('backlog service spin', () => {
  it('spins within a category and returns a card with matching mode and reasons', async () => {
    const deps = mockDeps();
    const result = await spinBacklog('user1', { category: 'never-played' }, deps);

    expect(result.card).not.toBeNull();
    expect(result.card?.appid).toBe(1);
    expect(result.card?.modeId).toBe('dust-collector');
    expect(result.card?.reasons.some(r => r.code === 'never_launched')).toBe(true);
    expect(result.poolSize).toBe(1);
    expect(deps.recordRoll).toHaveBeenCalledWith(
      'user1',
      expect.objectContaining({
        appid: 1,
        modeId: 'dust-collector',
        reasons: expect.arrayContaining([expect.objectContaining({ code: 'never_launched' })]),
      }),
      NOW_MS,
    );
  });

  it('spins high-completion category with finish-something mode and ach_near_complete reason', async () => {
    const deps = mockDeps();
    const result = await spinBacklog('user1', { category: 'high-completion-but-unfinished' }, deps);

    expect(result.card).not.toBeNull();
    expect(result.card?.appid).toBe(6);
    expect(result.card?.modeId).toBe('finish-something');
    expect(result.card?.reasons.some(r => r.code === 'ach_near_complete')).toBe(true);
    expect(modeForCategory('high-completion-but-unfinished')).toBe('finish-something');
  });

  it('spins low-completion category with achievement-hunter mode and ach_remaining reason', async () => {
    const deps = mockDeps();
    const result = await spinBacklog('user1', { category: 'low-completion' }, deps);

    expect(result.card).not.toBeNull();
    expect(result.card?.appid).toBe(5);
    expect(result.card?.modeId).toBe('achievement-hunter');
    expect(result.card?.reasons.some(r => r.code === 'ach_remaining')).toBe(true);
  });

  it('respects the exclude parameter to support rerolls', async () => {
    const deps = mockDeps({
      getCandidates: vi.fn().mockResolvedValue({
        candidates: [
          createCandidate(10, 'Game A', 0),
          createCandidate(20, 'Game B', 0),
        ],
        playtimeHidden: false,
        built: true,
      }),
    });
    const result = await spinBacklog('user1', { category: 'never-played', exclude: [10] }, deps);
    expect(result.card?.appid).toBe(20);
    expect(result.poolSize).toBe(1);
  });

  it('respects stored exclusions (vetoed games)', async () => {
    const deps = mockDeps({
      getExclusions: vi.fn().mockResolvedValue(new Set([1])),
    });
    const result = await spinBacklog('user1', { category: 'never-played' }, deps);
    expect(result.card).toBeNull();
    expect(result.poolSize).toBe(0);
  });

  it('passes sessionId to getExclusions in spinBacklog', async () => {
    const deps = mockDeps();
    await spinBacklog('user1', { category: 'never-played', sessionId: 'sess_xyz' }, deps);
    expect(deps.getExclusions).toHaveBeenCalledWith('user1', NOW_MS, 'sess_xyz');
  });

  it('returns card: null when no games match the category', async () => {
    const deps = mockDeps({
      getCandidates: vi.fn().mockResolvedValue({
        candidates: [createCandidate(1, 'Game 1', 1000, 10)],
        playtimeHidden: false,
        built: true,
      }),
    });
    const result = await spinBacklog('user1', { category: 'never-played' }, deps);
    expect(result.card).toBeNull();
    expect(result.poolSize).toBe(0);
  });

  it('produces deterministic draws when seed is provided', async () => {
    const deps = mockDeps({
      getCandidates: vi.fn().mockResolvedValue({
        candidates: [
          createCandidate(10, 'Game A', 0),
          createCandidate(20, 'Game B', 0),
          createCandidate(30, 'Game C', 0),
        ],
        playtimeHidden: false,
        built: true,
      }),
    });
    const r1 = await spinBacklog('user1', { category: 'never-played', seed: 'test_seed_42' }, deps);
    const r2 = await spinBacklog('user1', { category: 'never-played', seed: 'test_seed_42' }, deps);
    expect(r1.card?.appid).toBe(r2.card?.appid);
  });

  it('builds reasons for barely-played, idle, and started-but-abandoned', () => {
    const cBarely = createCandidate(2, 'Barely', 50);
    const rBarely = buildBacklogReasons(cBarely, 'barely-played', NOW_SECONDS);
    expect(rBarely[0]).toMatchObject({ code: 'barely_played', params: { minutes: 50 } });

    const cIdle = createCandidate(3, 'Idle', 2000, 180);
    const rIdle = buildBacklogReasons(cIdle, 'not-played-in-a-long-time', NOW_SECONDS);
    expect(rIdle[0]).toMatchObject({ code: 'idle', params: { months: 6 } });

    const cAbandoned = createCandidate(4, 'Abandoned', 90, 120);
    const rAbandoned = buildBacklogReasons(cAbandoned, 'started-but-abandoned', NOW_SECONDS);
    expect(rAbandoned[0]).toMatchObject({ code: 'idle', params: { months: 4 } });
    expect(rAbandoned[1]).toMatchObject({ code: 'barely_played', params: { minutes: 90 } });
  });
});
