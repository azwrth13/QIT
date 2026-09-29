import type { RollInput } from '../history/rolls';
import { buildCard } from './card';
import { applyPool, requiredFamilies, type ParsedFilter, type PoolPreview, type PoolStages } from './filter-engine';
import type { ParsedSpinRequest } from './request';
import { createRng } from './sampler';
import { roll, scoreCandidates } from './scoring';
import type {
  Candidate, Card, FilterContext, FilterId, Scope, ScopeKind, ScopeResolver, ScopeResult, SignalFamily, SpinResponse, Thresholds,
} from './types';

// The spin pipeline (plan section 2.5): resolve scope -> build pool -> exclusions -> filters -> bounded enrichment
// -> score -> sample -> Card -> record the roll. Everything that touches Firestore or Steam arrives through
// `PipelineDeps` (wired in `service.ts`), so this module stays testable with plain data.

/** A scope result, plus what the library scope knows about the requester. */
export interface SpinScopeResult extends ScopeResult {
  /** Steam hides the requester's playtime, so every game reads 0 minutes (see `detectPlaytimeHidden`). */
  playtimeHidden?: boolean;
}

/** A scope resolver, plus the signal families it attaches to its candidates besides `library`. */
export type SpinScopeResolver<K extends ScopeKind = ScopeKind> = ScopeResolver<K> & { provides?: readonly SignalFamily[] };
export type ScopeResolvers = { [K in ScopeKind]?: SpinScopeResolver<K> };

export interface LoadContext {
  steamId: string;
  scope: Scope;
  /** Milliseconds. */
  now: number;
  sessionId?: string;
  filters: readonly ParsedFilter[];
  /** false for pool previews: use stored data only, never call Steam. */
  fetch: boolean;
}

/**
 * Fills one signal family on the candidates (in place) where it can. A candidate it cannot fill keeps the family
 * missing, which filters read as unknown and coverage reports. Throwing fails the request.
 */
export type SignalLoader = (candidates: Candidate[], ctx: LoadContext) => Promise<void>;
export type SignalLoaders = Partial<Record<SignalFamily, SignalLoader>>;

export interface PipelineDeps {
  resolvers: ScopeResolvers;
  loaders: SignalLoaders;
  recordRoll(steamId: string, input: RollInput, now: number): Promise<string>;
  /** Header art for the drawn game when its signals carry none; null when unknown. */
  headerArt(appid: number): Promise<string | null>;
  thresholds: Thresholds;
  now(): number;
  randomSeed(): string;
  logError(context: string, error: unknown): void;
}

/** A request the pipeline cannot serve as asked; the route answers 400 with the message. */
export class SpinInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpinInputError';
  }
}

/** Filters that read playtime or recency, which a playtime-hidden library reports as zero for every game. */
export const PLAYTIME_FILTERS: readonly FilterId[] = ['never-played', 'playtime', 'recently-played', 'not-recently-played'];

export interface SpinResult extends SpinResponse {
  /** The seed the draw used; pass it back as `seed` to replay the same draw over the same pool. */
  seed: string;
  /** Games the mode found eligible in the pool. */
  eligible: number;
  preview: PoolPreview;
  playtimeHidden: boolean;
}

export interface PoolResult {
  preview: PoolPreview;
  coverage: SpinResponse['coverage'];
  /** Games the mode would find eligible; null when the request names no mode. */
  eligible: number | null;
  playtimeHidden: boolean;
}

/** `MAX_ROLL_REASONS` in `history/rolls.ts`, which this module cannot import without Firestore. */
const ROLL_REASON_LIMIT = 10;

const FAMILY_ORDER: readonly SignalFamily[] = ['library', 'store', 'achievements', 'live', 'history', 'group'];

/** Share (0-1, four decimals) of `candidates` holding each family; 1 for an empty list. */
export function coverageOf(candidates: readonly Candidate[], families: readonly SignalFamily[]): SpinResponse['coverage'] {
  const coverage: SpinResponse['coverage'] = {};
  for (const family of families) {
    const loaded = candidates.filter(candidate => candidate.signals[family] !== undefined).length;
    coverage[family] = candidates.length ? Math.round(loaded / candidates.length * 1e4) / 1e4 : 1;
  }
  return coverage;
}

/**
 * Signal families that have a source today: `library`, a registered loader, or a family a resolver attaches. With a
 * scope kind, only that scope's resolver counts; without one, any registered resolver does.
 */
export function sourcedFamilies(deps: Pick<PipelineDeps, 'resolvers' | 'loaders'>, kind?: ScopeKind): Set<SignalFamily> {
  const resolvers = (kind ? [deps.resolvers[kind]] : Object.values(deps.resolvers)) as Array<SpinScopeResolver | undefined>;
  return new Set<SignalFamily>([
    'library',
    ...(Object.keys(deps.loaders) as SignalFamily[]).filter(family => deps.loaders[family]),
    ...resolvers.flatMap(resolver => resolver?.provides ?? []),
  ]);
}

export const isSourced = (requires: readonly SignalFamily[], sourced: ReadonlySet<SignalFamily>) => requires.every(family => sourced.has(family));

/** The mode or first filter of `request` needing a family `sourced` lacks; such a request can never match anything. */
export function unsourcedSelection(request: Pick<ParsedSpinRequest, 'mode' | 'filters'>, sourced: ReadonlySet<SignalFamily>): string | null {
  if (request.mode && !isSourced(request.mode.requires, sourced)) return `mode ${request.mode.id}`;
  const filter = request.filters.find(({ filter }) => !isSourced(filter.requires, sourced));
  return filter ? `filter ${filter.filter.id}` : null;
}

async function resolveScope(request: ParsedSpinRequest, steamId: string, now: number, deps: PipelineDeps): Promise<SpinScopeResult> {
  const resolver = deps.resolvers[request.scope.kind] as ScopeResolver | undefined;
  if (!resolver) throw new SpinInputError(`scope ${request.scope.kind} is not available yet`);
  const unsourced = unsourcedSelection(request, sourcedFamilies(deps, request.scope.kind));
  if (unsourced) throw new SpinInputError(`${unsourced} is not available for scope ${request.scope.kind}`);
  const result: SpinScopeResult = await resolver.resolve(request.scope, { steamId, now });
  if (result.playtimeHidden) {
    const blocked = request.filters.find(({ filter }) => PLAYTIME_FILTERS.includes(filter.id));
    if (blocked) throw new SpinInputError(`filter ${blocked.filter.id} needs playtime, which this Steam profile hides`);
  }
  return result;
}

async function load(candidates: Candidate[], families: readonly SignalFamily[], ctx: LoadContext, deps: PipelineDeps): Promise<void> {
  await Promise.all(families.map(family => deps.loaders[family]?.(candidates, ctx)));
}

interface Pool {
  scope: SpinScopeResult;
  pool: Candidate[];
  preview: PoolPreview;
  /** The families each candidate set was loaded for, for coverage. */
  stageFamilies: SignalFamily[];
  filterCtx: FilterContext;
}

/** Resolve, load what the exclusion stage and filters read, then apply them. */
async function buildPool(steamId: string, request: ParsedSpinRequest, deps: PipelineDeps, now: number, fetch: boolean): Promise<Pool> {
  const scope = await resolveScope(request, steamId, now, deps);
  const stages: PoolStages = { exclusions: { exclude: request.exclude, showNonGames: request.showNonGames }, filters: request.filters };
  const stageFamilies = requiredFamilies(stages);
  const ctx: LoadContext = { steamId, scope: request.scope, now, sessionId: request.sessionId, filters: request.filters, fetch };
  await load(scope.candidates, stageFamilies, ctx, deps);
  const filterCtx: FilterContext = {
    now: Math.floor(now / 1000), thresholds: deps.thresholds, scope: request.scope,
    members: [...scope.members, ...scope.unavailable.map(player => player.steamId)],
  };
  const { candidates: pool, preview } = applyPool(scope.candidates, stages, filterCtx);
  // Signals only the mode needs are loaded for the games that survived the filters (bounded enrichment).
  const modeFamilies = (request.mode?.requires ?? []).filter(family => !stageFamilies.includes(family));
  await load(pool, modeFamilies, ctx, deps);
  return { scope, pool, preview, stageFamilies, filterCtx };
}

function coverageFor(pool: Pool, request: ParsedSpinRequest): SpinResponse['coverage'] {
  const modeFamilies = (request.mode?.requires ?? []).filter(family => !pool.stageFamilies.includes(family));
  const byFamily = {
    ...coverageOf(pool.scope.candidates, pool.stageFamilies),
    ...coverageOf(pool.pool, modeFamilies),
  };
  const ordered: SpinResponse['coverage'] = {};
  for (const family of FAMILY_ORDER) if (byFamily[family] !== undefined) ordered[family] = byFamily[family];
  return ordered;
}

/**
 * Runs a spin for `steamId` and records the roll. An empty pool (or no eligible game) returns `card: null` and
 * records nothing. A roll that cannot be stored still returns the card, with `rollId: null`.
 */
export async function runSpin(steamId: string, request: ParsedSpinRequest, deps: PipelineDeps): Promise<SpinResult> {
  const mode = request.mode;
  if (!mode) throw new SpinInputError('mode is required');
  const now = deps.now();
  const built = await buildPool(steamId, request, deps, now, true);
  const coverage = coverageFor(built, request);
  const seed = request.seed ?? deps.randomSeed();
  const { picks, eligible } = roll(mode, built.pool, { now: built.filterCtx.now, thresholds: deps.thresholds, scope: request.scope }, { rng: createRng(seed) });
  const result = { poolSize: built.pool.length, coverage, seed, eligible, preview: built.preview, playtimeHidden: built.scope.playtimeHidden === true };
  const pick = picks[0];
  if (!pick) return { card: null, ...result };

  const { appid, signals } = pick.candidate;
  let rollId: string | null = null;
  try {
    rollId = await deps.recordRoll(steamId, {
      appid,
      name: signals.library.name.slice(0, 256),
      modeId: mode.id,
      filters: request.selections,
      scope: request.scope,
      participants: built.scope.members.length ? built.scope.members : [steamId],
      playtimeAtRoll: built.scope.playtimeHidden ? null : signals.library.playtimeForever,
      reasons: pick.reasons.slice(0, ROLL_REASON_LIMIT),
    }, now);
  } catch (error) {
    deps.logError('Roll could not be recorded', error);
  }
  let header = signals.store?.headerArt ?? null;
  if (!header) {
    try { header = await deps.headerArt(appid); } catch (error) { deps.logError('Header art lookup failed', error); }
  }
  const card: Card = buildCard(pick, { modeId: mode.id, rollId, header });
  return { card, ...result };
}

/** Pool counts for the picker's "N games match" line. Uses stored data only: no Steam calls, nothing written. */
export async function runPoolPreview(steamId: string, request: ParsedSpinRequest, deps: PipelineDeps): Promise<PoolResult> {
  const now = deps.now();
  const built = await buildPool(steamId, request, deps, now, false);
  const eligible = request.mode
    ? scoreCandidates(request.mode, built.pool, { now: built.filterCtx.now, thresholds: deps.thresholds, scope: request.scope }).length
    : null;
  return { preview: built.preview, coverage: coverageFor(built, request), eligible, playtimeHidden: built.scope.playtimeHidden === true };
}
