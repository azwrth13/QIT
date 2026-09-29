import { appArtUrl, getAppMeta } from '../apps/metadata';
import { recordRoll } from '../history/rolls';
import { logServerError } from '../steam';
import { SIGNAL_LOADERS } from './enrich';
import { listFilters } from './filters';
import { listModes } from './modes';
import { isSourced, runPoolPreview, runSpin, sourcedFamilies, type PipelineDeps, type PoolResult, type SpinResult } from './pipeline';
import type { ParsedSpinRequest } from './request';
import { randomSeed } from './sampler';
import { SCOPE_RESOLVERS } from './scopes';
import { THRESHOLDS } from './thresholds';
import type { ScopeKind, SignalFamily } from './types';

// The spin pipeline wired to Firestore and Steam, for the `/api/roulette/*` routes.

async function headerArt(appid: number): Promise<string | null> {
  const { meta } = await getAppMeta([appid], { maxFetch: 1 });
  const app = meta.get(appid);
  return app?.state === 'ok' ? appArtUrl(appid, app.art, 'header') : null;
}

export const DEFAULT_DEPS: PipelineDeps = {
  resolvers: SCOPE_RESOLVERS,
  loaders: SIGNAL_LOADERS,
  recordRoll,
  headerArt,
  thresholds: THRESHOLDS,
  now: Date.now,
  randomSeed,
  logError: logServerError,
};

/** Families with a source in some scope today; requests reading any other family are rejected (`parseSpinRequest`). */
export const SOURCED_FAMILIES: ReadonlySet<SignalFamily> = sourcedFamilies(DEFAULT_DEPS);

export function spin(steamId: string, request: ParsedSpinRequest, deps: PipelineDeps = DEFAULT_DEPS): Promise<SpinResult> {
  return runSpin(steamId, request, deps);
}

export function previewPool(steamId: string, request: ParsedSpinRequest, deps: PipelineDeps = DEFAULT_DEPS): Promise<PoolResult> {
  return runPoolPreview(steamId, request, deps);
}

export interface ModesCatalog {
  modes: Array<{ id: string; label: string; description: string; requires: SignalFamily[]; scopes: ScopeKind[] }>;
  filters: Array<{ id: string; label: string; description: string; requires: SignalFamily[] }>;
  /** Scope kinds the pipeline can resolve today. */
  scopes: ScopeKind[];
}

/**
 * What the picker may offer: implemented modes and filters whose signal families all have a source (stubs are never
 * listed). A mode lists only the scopes that can source what it reads.
 */
export function modesCatalog(deps: Pick<PipelineDeps, 'resolvers' | 'loaders'> = DEFAULT_DEPS): ModesCatalog {
  const scopes = (Object.keys(deps.resolvers) as ScopeKind[]).filter(kind => deps.resolvers[kind]);
  const sourced = sourcedFamilies(deps);
  return {
    modes: listModes().filter(mode => !mode.stub).map(({ id, label, description, requires, scopes: modeScopes }) => ({
      id, label, description, requires: [...requires],
      scopes: modeScopes.filter(kind => scopes.includes(kind) && isSourced(requires, sourcedFamilies(deps, kind))),
    })).filter(mode => mode.scopes.length),
    filters: listFilters().filter(filter => !filter.stub && isSourced(filter.requires, sourced))
      .map(({ id, label, description, requires }) => ({ id, label, description, requires: [...requires] })),
    scopes,
  };
}
