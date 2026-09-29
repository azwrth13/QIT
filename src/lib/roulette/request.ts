import { isSteamId } from '../steam';
import { MAX_WITH_IDS } from '../links/with-param';
import { parseFilterSelections, type ParsedFilter } from './filter-engine';
import { getMode, isModeId } from './modes';
import { SCOPE_KINDS, type FilterSelection, type Mode, type Scope, type ScopeKind } from './types';

// Validates the JSON body of `POST /api/roulette/spin` and `POST /api/roulette/pool`. Pure. Request bodies are
// untrusted, so anything unrecognised (an unknown key, a stub mode, a malformed scope) is rejected rather than
// half-applied, matching the filters' own `parse`.

/** Most appids one request may leave out (`exclude`), for example the earlier results of a picker session. */
export const MAX_EXCLUDE = 500;
/** Most appids an explicit `appids` scope may name; matches what a roll can store. */
export const MAX_SCOPE_APPIDS = 500;
export const MAX_SEED_LENGTH = 128;
/** Request body cap: room for a full `exclude` list and every filter with params. */
export const SPIN_MAX_BODY_BYTES = 16 * 1024;
// Session ids and lobby codes use the same alphabets as `history/exclusions.ts` and `history/rolls.ts`.
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LOBBY_CODE = /^[A-Za-z0-9_-]{1,32}$/;

const SPIN_KEYS = ['mode', 'filters', 'scope', 'exclude', 'showNonGames', 'sessionId', 'seed'] as const;
const POOL_KEYS = ['mode', 'filters', 'scope', 'exclude', 'showNonGames', 'sessionId'] as const;

export interface ParsedSpinRequest {
  /** null only for a pool request that names no mode. */
  mode: Mode | null;
  filters: ParsedFilter[];
  /** The filters as they will be stored with the roll: id plus the validated params (omitted when empty). */
  selections: FilterSelection[];
  scope: Scope;
  /** Unique appids to leave out of this spin only. */
  exclude: number[];
  /** Keep non-game apps in the pool (D17 hides them by default). */
  showNonGames: boolean;
  /** Picker or lobby session, so "Hide for this session" exclusions apply. */
  sessionId?: string;
  /** Deterministic draw; omitted means a fresh random seed. */
  seed?: string;
}

export type ParseSpinResult = { ok: true; request: ParsedSpinRequest } | { ok: false; error: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isAppId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function uniqueSteamIds(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > max || !value.every(isSteamId)) return null;
  return new Set(value).size === value.length ? [...value] : null;
}

/** Reads a scope; a missing scope is the requester's own library. Only the shape is checked here: resolvers own the rest. */
export function parseScope(raw: unknown): Scope | null {
  if (raw === undefined || raw === null) return { kind: 'library' };
  if (!isPlainObject(raw) || !(SCOPE_KINDS as readonly unknown[]).includes(raw.kind)) return null;
  const kind = raw.kind as ScopeKind;
  const keys = Object.keys(raw);
  const only = (...allowed: string[]) => keys.every(key => key === 'kind' || allowed.includes(key));
  switch (kind) {
    case 'library':
      return only() ? { kind } : null;
    case 'friends': {
      const ids = only('with') ? uniqueSteamIds(raw.with, MAX_WITH_IDS) : null;
      return ids ? { kind, with: ids } : null;
    }
    case 'pair':
      return only('with') && isSteamId(raw.with) ? { kind, with: raw.with } : null;
    case 'lobby':
      return only('code') && typeof raw.code === 'string' && LOBBY_CODE.test(raw.code) ? { kind, code: raw.code } : null;
    case 'appids': {
      const appids = raw.appids;
      if (!only('appids') || !Array.isArray(appids) || !appids.length || appids.length > MAX_SCOPE_APPIDS || !appids.every(isAppId)) return null;
      return { kind, appids: [...new Set(appids)] };
    }
  }
}

function parseExclude(raw: unknown): number[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_EXCLUDE || !raw.every(isAppId)) return null;
  return [...new Set(raw)];
}

function selectionsOf(filters: readonly ParsedFilter[]): FilterSelection[] {
  return filters.map(({ filter, params }) => isPlainObject(params) && !Object.keys(params).length
    ? { id: filter.id }
    : { id: filter.id, params });
}

/**
 * Validates a spin (`kind: 'spin'`, mode required, seed allowed) or pool preview (`kind: 'pool'`, mode optional,
 * no seed) request. The mode must be implemented and must support the scope.
 */
export function parseSpinRequest(raw: unknown, kind: 'spin' | 'pool' = 'spin'): ParseSpinResult {
  if (!isPlainObject(raw)) return { ok: false, error: 'request body must be an object' };
  const allowed: readonly string[] = kind === 'spin' ? SPIN_KEYS : POOL_KEYS;
  const unknownKey = Object.keys(raw).find(key => !allowed.includes(key));
  if (unknownKey !== undefined) return { ok: false, error: `unknown field ${unknownKey.slice(0, 40)}` };

  let mode: Mode | null = null;
  if (raw.mode !== undefined || kind === 'spin') {
    if (!isModeId(raw.mode)) return { ok: false, error: 'unknown mode' };
    mode = getMode(raw.mode);
    if (mode.stub) return { ok: false, error: `mode ${mode.id} is not available` };
  }

  const parsed = parseFilterSelections(raw.filters);
  if (!parsed.ok) return parsed;

  const scope = parseScope(raw.scope);
  if (!scope) return { ok: false, error: 'invalid scope' };
  if (mode && !mode.scopes.includes(scope.kind)) return { ok: false, error: `mode ${mode.id} does not support scope ${scope.kind}` };

  const exclude = parseExclude(raw.exclude);
  if (!exclude) return { ok: false, error: `exclude must be a list of at most ${MAX_EXCLUDE} app IDs` };
  if (raw.showNonGames !== undefined && typeof raw.showNonGames !== 'boolean') return { ok: false, error: 'showNonGames must be a boolean' };
  if (raw.sessionId !== undefined && !(typeof raw.sessionId === 'string' && SESSION_ID.test(raw.sessionId))) {
    return { ok: false, error: 'invalid sessionId' };
  }
  if (raw.seed !== undefined && !(typeof raw.seed === 'string' && raw.seed.length > 0 && raw.seed.length <= MAX_SEED_LENGTH)) {
    return { ok: false, error: `seed must be a string of 1 to ${MAX_SEED_LENGTH} characters` };
  }

  const request: ParsedSpinRequest = {
    mode, filters: parsed.filters, selections: selectionsOf(parsed.filters), scope, exclude, showNonGames: raw.showNonGames === true,
  };
  if (raw.sessionId !== undefined) request.sessionId = raw.sessionId as string;
  if (raw.seed !== undefined) request.seed = raw.seed as string;
  return { ok: true, request };
}
