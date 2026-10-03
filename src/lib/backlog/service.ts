import { appArtUrl, getAppMeta } from '../apps/metadata';
import { db } from '../firestore';
import { recordRoll, type RollInput } from '../history/rolls';
import { liveEntries } from '../history/exclusions';
import { BACKLOG_CATEGORIES, type BacklogCategory, type BacklogContext } from '../library/backlog';
import { getLibraryGames } from '../library';
import { buildCard } from '../roulette/card';
import { isNonGameType } from '../roulette/exclusions';
import { reason } from '../roulette/reasons';
import { createRng, randomSeed, weightedSample } from '../roulette/sampler';
import { candidateFromGame, candidateFromIndexEntry } from '../roulette/scopes/library';
import { THRESHOLDS } from '../roulette/thresholds';
import type { Candidate, Card, ModeId, Reason, Thresholds } from '../roulette/types';
import { logServerError } from '../steam';
import { readLibIndex } from '../store/lib-index';
import { paths } from '../store/paths';
import type { UserRecord } from '../store/types';
import {
  BACKLOG_CATEGORY_IDS,
  type BacklogCategoryStatus,
  type BacklogCategorySummary,
  type BacklogGameItem,
  type BacklogOverview,
  type BacklogSpinRequest,
  type BacklogSpinResponse,
} from './types';

export const BACKLOG_CATEGORY_META: Record<BacklogCategory, { label: string; description: string }> = {
  'never-played': {
    label: 'Never played',
    description: 'Games in your library you have never launched.',
  },
  'barely-played': {
    label: 'Barely played',
    description: 'Games with under 2 hours of playtime (Steam refund window).',
  },
  'not-played-in-a-long-time': {
    label: 'Not played in a long time',
    description: 'Games you haven\'t played in over 90 days.',
  },
  'started-but-abandoned': {
    label: 'Started but abandoned',
    description: 'Games played between 30 minutes and 10 hours, left untouched for 90+ days.',
  },
  'low-completion': {
    label: 'Low achievement completion',
    description: 'Games where you have unlocked under 60% of achievements.',
  },
  'high-completion-but-unfinished': {
    label: 'High achievement completion',
    description: 'Games where you have unlocked 80% or more of achievements, but haven\'t finished.',
  },
};

const isAppId = (id: number) => Number.isSafeInteger(id) && id > 0;

export async function defaultGetCandidates(steamId: string): Promise<{
  candidates: Candidate[];
  playtimeHidden: boolean;
  built: boolean;
}> {
  const [userDoc, index] = await Promise.all([
    db.doc(paths.user(steamId)).get(),
    readLibIndex(steamId),
  ]);
  const user = userDoc.data() as Partial<UserRecord> | undefined;
  const playtimeHidden = user?.flags?.playtimeHidden === true;
  const candidates = index.built
    ? [...index.entries].filter(([appid]) => isAppId(appid)).map(([appid, entry]) => candidateFromIndexEntry(appid, entry))
    : (await getLibraryGames(steamId)).games.filter(game => isAppId(game.appid)).map(candidateFromGame);
  return { candidates, playtimeHidden, built: index.built };
}

export async function defaultGetExclusions(steamId: string, now: number): Promise<Set<number>> {
  const doc = await db.doc(paths.exclusions(steamId)).get();
  const live = liveEntries(doc.data() as Record<string, unknown> | undefined, now);
  const set = new Set<number>();
  for (const appidStr of live.keys()) {
    const id = Number(appidStr);
    if (isAppId(id)) set.add(id);
  }
  return set;
}

async function defaultHeaderArt(appid: number): Promise<string | null> {
  const { meta } = await getAppMeta([appid], { maxFetch: 1 });
  const app = meta.get(appid);
  return app?.state === 'ok' ? appArtUrl(appid, app.art, 'header') : null;
}

export interface BacklogDeps {
  getCandidates(steamId: string): Promise<{ candidates: Candidate[]; playtimeHidden: boolean; built: boolean }>;
  getExclusions(steamId: string, now: number): Promise<Set<number>>;
  recordRoll(steamId: string, input: RollInput, now: number): Promise<string>;
  headerArt(appid: number): Promise<string | null>;
  thresholds: Thresholds;
  now(): number;
  randomSeed(): string;
  logError(context: string, error: unknown): void;
}

export const DEFAULT_BACKLOG_DEPS: BacklogDeps = {
  getCandidates: defaultGetCandidates,
  getExclusions: defaultGetExclusions,
  recordRoll,
  headerArt: defaultHeaderArt,
  thresholds: THRESHOLDS,
  now: () => Date.now(),
  randomSeed,
  logError: logServerError,
};

function formatGameItem(candidate: Candidate): BacklogGameItem {
  const lib = candidate.signals.library;
  const ach = candidate.signals.achievements;
  return {
    appid: candidate.appid,
    name: lib.name,
    playtimeForever: lib.playtimeForever,
    lastPlayedAt: lib.lastPlayedAt,
    achievements: ach ? { unlocked: ach.unlocked, total: ach.total, percent: ach.percent } : null,
    iconHash: lib.iconHash,
  };
}

export async function getBacklogOverview(
  steamId: string,
  deps: BacklogDeps = DEFAULT_BACKLOG_DEPS,
): Promise<BacklogOverview> {
  const nowMs = deps.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const { candidates, playtimeHidden, built } = await deps.getCandidates(steamId);

  const ctx: BacklogContext = {
    now: nowSeconds,
    thresholds: deps.thresholds,
    playtimeHidden,
  };

  let scannedGames = 0;
  let unscannedGames = 0;
  for (const candidate of candidates) {
    if (candidate.signals.achievements !== undefined && candidate.signals.achievements !== null) {
      scannedGames++;
    } else {
      unscannedGames++;
    }
  }

  const summaries: Partial<Record<BacklogCategory, BacklogCategorySummary>> = {};

  for (const id of BACKLOG_CATEGORY_IDS) {
    const meta = BACKLOG_CATEGORY_META[id];
    const categoryFn = BACKLOG_CATEGORIES[id];
    const matchedGames: BacklogGameItem[] = [];
    let unscannedForCategory = 0;

    for (const candidate of candidates) {
      if (isNonGameType(candidate.signals.store?.type ?? null)) continue;
      const verdict = categoryFn(candidate, ctx);
      if (verdict === 'match') {
        matchedGames.push(formatGameItem(candidate));
      } else if (verdict === 'unscanned') {
        unscannedForCategory++;
      }
    }

    let status: BacklogCategoryStatus = 'ready';
    if (id === 'low-completion' || id === 'high-completion-but-unfinished') {
      if (scannedGames === 0 && unscannedForCategory > 0) {
        status = 'scan_required';
      }
    } else if (playtimeHidden) {
      status = 'playtime_hidden';
    }

    summaries[id] = {
      id,
      label: meta.label,
      description: meta.description,
      count: matchedGames.length,
      games: matchedGames,
      status,
      unscannedCount: unscannedForCategory,
    };
  }

  return {
    categories: summaries as Record<BacklogCategory, BacklogCategorySummary>,
    playtimeHidden,
    libraryBuilt: built,
    totalGames: candidates.length,
    scannedGames,
    unscannedGames,
  };
}

export function buildBacklogReasons(candidate: Candidate, category: BacklogCategory, nowSeconds: number): Reason[] {
  const lib = candidate.signals.library;
  const ach = candidate.signals.achievements;
  const reasons: Reason[] = [];

  switch (category) {
    case 'never-played':
      reasons.push(reason('never_launched', {}));
      break;
    case 'barely-played':
      reasons.push(reason('barely_played', { minutes: lib.playtimeForever }));
      break;
    case 'not-played-in-a-long-time': {
      const months = lib.lastPlayedAt ? Math.max(1, Math.floor((nowSeconds - lib.lastPlayedAt) / (30 * 86_400))) : 3;
      reasons.push(reason('idle', { months }));
      break;
    }
    case 'started-but-abandoned': {
      const months = lib.lastPlayedAt ? Math.max(1, Math.floor((nowSeconds - lib.lastPlayedAt) / (30 * 86_400))) : 3;
      reasons.push(reason('idle', { months }));
      reasons.push(reason('barely_played', { minutes: lib.playtimeForever }));
      break;
    }
    case 'low-completion':
      if (ach && ach.total > 0) {
        reasons.push(reason('ach_remaining', { remaining: ach.total - ach.unlocked, total: ach.total }));
      }
      break;
    case 'high-completion-but-unfinished':
      if (ach && ach.total > 0) {
        reasons.push(reason('ach_near_complete', { percent: ach.percent, remaining: ach.total - ach.unlocked }));
      }
      break;
  }

  if (candidate.signals.history && candidate.signals.history.timesRolled === 0) {
    reasons.push(reason('not_rolled_recently', {}));
  }

  if (reasons.length === 0) {
    reasons.push(reason('random_pick', {}));
  }

  return reasons;
}

export function modeForCategory(category: BacklogCategory): ModeId {
  switch (category) {
    case 'low-completion':
      return 'achievement-hunter';
    case 'high-completion-but-unfinished':
      return 'finish-something';
    case 'never-played':
    case 'barely-played':
    case 'not-played-in-a-long-time':
    case 'started-but-abandoned':
    default:
      return 'dust-collector';
  }
}

export async function spinBacklog(
  steamId: string,
  request: BacklogSpinRequest,
  deps: BacklogDeps = DEFAULT_BACKLOG_DEPS,
): Promise<BacklogSpinResponse> {
  const nowMs = deps.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const { candidates, playtimeHidden } = await deps.getCandidates(steamId);

  const ctx: BacklogContext = {
    now: nowSeconds,
    thresholds: deps.thresholds,
    playtimeHidden,
  };

  const categoryFn = BACKLOG_CATEGORIES[request.category];
  const matched = candidates.filter(candidate => {
    if (isNonGameType(candidate.signals.store?.type ?? null)) return false;
    return categoryFn(candidate, ctx) === 'match';
  });

  const excludedFromRequest = new Set(request.exclude ?? []);
  const storedExclusions = await deps.getExclusions(steamId, nowMs);

  const eligiblePool = matched.filter(
    candidate => !excludedFromRequest.has(candidate.appid) && !storedExclusions.has(candidate.appid),
  );

  if (eligiblePool.length === 0) {
    return {
      card: null,
      poolSize: 0,
      category: request.category,
      seed: request.seed ?? deps.randomSeed(),
    };
  }

  const seed = request.seed ?? deps.randomSeed();
  const rng = createRng(seed);

  const weightedCandidates = eligiblePool.map(candidate => {
    let weight = 1;
    if (request.category === 'barely-played') {
      weight = 1 + Math.max(0, (deps.thresholds.barelyPlayedMinutes - candidate.signals.library.playtimeForever) / 60);
    } else if (request.category === 'not-played-in-a-long-time' || request.category === 'started-but-abandoned') {
      const idleMonths = candidate.signals.library.lastPlayedAt
        ? (nowSeconds - candidate.signals.library.lastPlayedAt) / (30 * 86_400)
        : 3;
      weight = 1 + Math.min(5, idleMonths / 6);
    } else if (request.category === 'high-completion-but-unfinished') {
      weight = 1 + (candidate.signals.achievements?.percent ?? 0) / 100;
    } else if (request.category === 'low-completion') {
      const remaining = (candidate.signals.achievements?.total ?? 1) - (candidate.signals.achievements?.unlocked ?? 0);
      weight = 1 + Math.min(3, remaining / 20);
    }
    return { item: candidate, weight };
  });

  const [picked] = weightedSample(weightedCandidates, 1, { rng, gamma: deps.thresholds.samplerGamma });
  const reasons = buildBacklogReasons(picked, request.category, nowSeconds);
  const modeId = modeForCategory(request.category);

  let rollId: string | null = null;
  try {
    rollId = await deps.recordRoll(
      steamId,
      {
        appid: picked.appid,
        name: picked.signals.library.name.slice(0, 256),
        modeId,
        filters: [],
        scope: { kind: 'library' },
        participants: [steamId],
        playtimeAtRoll: playtimeHidden ? null : picked.signals.library.playtimeForever,
        reasons,
      },
      nowMs,
    );
  } catch (error) {
    deps.logError('Backlog roll could not be recorded', error);
  }

  let header = picked.signals.store?.headerArt ?? null;
  if (!header) {
    try {
      header = await deps.headerArt(picked.appid);
    } catch (error) {
      deps.logError('Header art lookup failed', error);
    }
  }

  const card: Card = buildCard({ candidate: picked, reasons, weight: 1 }, { modeId, rollId, header });

  return {
    card,
    poolSize: eligiblePool.length,
    category: request.category,
    seed,
  };
}
