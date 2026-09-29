import { getFilter, isFilterId } from './filters';
import { applyExclusions, exclusionRequires, type ExclusionCause, type ExclusionOptions } from './exclusions';
import type { Candidate, Filter, FilterContext, FilterId, FilterSelection, FilterVerdict, SignalFamily } from './types';

// Composes the session filters (feature 18) and the exclusion stage into the pool the modes score.
// Pure: it never loads data. `requiredFamilies` tells the pipeline what to enrich first, and the
// verdicts for signals that are not there yet come back as 'unknown' rather than 'fail'.

/** Most filters one request may carry: each id at most once. */
export const MAX_FILTERS = 11;

const FAMILY_ORDER: readonly SignalFamily[] = ['library', 'store', 'achievements', 'live', 'history', 'group'];

export interface ParsedFilter {
  filter: Filter;
  /** Output of `filter.parse`, ready for `filter.test`. */
  params: unknown;
}

export type ParseFiltersResult =
  | { ok: true; filters: ParsedFilter[] }
  | { ok: false; error: string };

/** Validates the `filters` of a spin request: known and implemented ids, valid params, no repeats. */
export function parseFilterSelections(raw: unknown): ParseFiltersResult {
  if (raw === undefined || raw === null) return { ok: true, filters: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'filters must be a list' };
  if (raw.length > MAX_FILTERS) return { ok: false, error: `at most ${MAX_FILTERS} filters` };
  const filters: ParsedFilter[] = [];
  const seen = new Set<FilterId>();
  for (const selection of raw) {
    const id = typeof selection === 'object' && selection !== null && !Array.isArray(selection)
      ? (selection as Partial<FilterSelection>).id
      : undefined;
    if (!isFilterId(id)) return { ok: false, error: 'unknown filter' };
    if (seen.has(id)) return { ok: false, error: `filter ${id} is repeated` };
    seen.add(id);
    const filter = getFilter(id);
    if (filter.stub) return { ok: false, error: `filter ${id} is not available` };
    const params = filter.parse((selection as FilterSelection).params);
    if (params === null) return { ok: false, error: `invalid params for filter ${id}` };
    filters.push({ filter, params });
  }
  return { ok: true, filters };
}

/** What to do with a game a filter cannot judge yet. */
export type UnknownPolicy = 'exclude' | 'include';

export interface PoolStages {
  exclusions?: ExclusionOptions;
  filters?: readonly ParsedFilter[];
  /** Default `exclude`: a game that cannot be shown to match a filter the user chose stays out, and the preview counts it. */
  unknown?: UnknownPolicy;
}

/** Signal families the stages read, in a fixed order, for the pipeline to load before `applyPool`. */
export function requiredFamilies(stages: PoolStages): SignalFamily[] {
  const needed = new Set<SignalFamily>(exclusionRequires(stages.exclusions));
  for (const { filter } of stages.filters ?? []) filter.requires.forEach(family => needed.add(family));
  return FAMILY_ORDER.filter(family => needed.has(family));
}

export interface FilterStep {
  id: FilterId;
  /** Counts over the games that reached this filter. */
  passed: number;
  failed: number;
  unknown: number;
  /** Games still in the pool after this filter. */
  remaining: number;
}

export interface PoolPreview {
  total: number;
  /** Removals by the exclusion stage, and what was left after it. */
  removed: Record<ExclusionCause, number>;
  afterExclusions: number;
  /** One step per filter, in request order; each sees only the games earlier steps kept. */
  steps: FilterStep[];
  final: number;
}

export interface PoolResult {
  candidates: Candidate[];
  preview: PoolPreview;
}

/** Runs the exclusion stage, then each filter in turn. Filters combine with AND. */
export function applyPool(candidates: readonly Candidate[], stages: PoolStages, ctx: FilterContext): PoolResult {
  const { kept, removed } = applyExclusions(candidates, stages.exclusions);
  const keepUnknown = stages.unknown === 'include';
  const steps: FilterStep[] = [];
  let pool = kept;
  for (const { filter, params } of stages.filters ?? []) {
    const next: Candidate[] = [];
    const step: FilterStep = { id: filter.id, passed: 0, failed: 0, unknown: 0, remaining: 0 };
    for (const candidate of pool) {
      const verdict: FilterVerdict = filter.test(candidate, params, ctx);
      if (verdict === 'pass') step.passed++;
      else if (verdict === 'fail') step.failed++;
      else step.unknown++;
      if (verdict === 'pass' || (verdict === 'unknown' && keepUnknown)) next.push(candidate);
    }
    step.remaining = next.length;
    steps.push(step);
    pool = next;
  }
  return {
    candidates: pool,
    preview: { total: candidates.length, removed, afterExclusions: kept.length, steps, final: pool.length },
  };
}

/** How many games each stage would leave, for the picker's live "N games match" line. */
export function poolPreview(candidates: readonly Candidate[], stages: PoolStages, ctx: FilterContext): PoolPreview {
  return applyPool(candidates, stages, ctx).preview;
}
