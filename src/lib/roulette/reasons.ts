import type { ActivityBand, Reason, ReasonCode, ReasonParams } from './types';

// The single place that turns structured reasons into text (feature 8). Modes, group logic and
// the pipeline emit `{ code, params }`; cards, history and the lobby render them through here.

/** How many reasons a result card shows. */
export const CARD_REASON_LIMIT = 3;

const ACTIVITY_BANDS: readonly ActivityBand[] = ['high', 'mid', 'low'];

// Numeric params per code. Counts must be whole numbers; the rest may be fractional.
type ParamSpec = Record<string, 'count' | 'amount'>;
const PARAM_SPECS: { [C in ReasonCode]: ParamSpec } = {
  random_pick: {},
  never_launched: {},
  barely_played: { minutes: 'amount' },
  idle: { months: 'amount' },
  outside_rotation: {},
  comfort: { hours: 'amount' },
  rediscovery: { hours: 'amount', months: 'amount' },
  ach_remaining: { remaining: 'count', total: 'count' },
  ach_near_complete: { percent: 'amount', remaining: 'count' },
  rare_remaining: { count: 'count', threshold: 'amount' },
  // `band` is checked separately.
  active_now: { players: 'count' },
  friends_all_own: { count: 'count' },
  friends_never_played: { count: 'count' },
  not_rolled_recently: {},
};

export const REASON_CODES = Object.keys(PARAM_SPECS) as ReasonCode[];

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PARAM_SPECS, value);
}

/** Typed constructor: `reason('barely_played', { minutes: 45 })`. */
export function reason<C extends ReasonCode>(code: C, params: ReasonParams[C]): Reason {
  return { code, params } as Reason;
}

/**
 * Validates a reason read back from storage (rolls, lobby results) or the wire. Returns a clean
 * copy holding only the known params, or null when the code is unknown or a param is missing,
 * negative, non-finite, or not a whole number where a count is expected.
 */
export function parseReason(value: unknown): Reason | null {
  if (typeof value !== 'object' || value === null) return null;
  const { code, params } = value as { code?: unknown; params?: unknown };
  if (!isReasonCode(code)) return null;
  const raw = params === undefined ? {} : params;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(PARAM_SPECS[code])) {
    const n = (raw as Record<string, unknown>)[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    if (kind === 'count' && !Number.isInteger(n)) return null;
    clean[key] = n;
  }
  if (code === 'active_now') {
    const band = (raw as Record<string, unknown>).band ?? null;
    if (band !== null && !ACTIVITY_BANDS.includes(band as ActivityBand)) return null;
    clean.band = band;
  }
  return { code, params: clean } as Reason;
}

/**
 * Orders reasons by a mode's declared priority (`Mode.emits`). Codes the mode does not declare,
 * such as group reasons added by the pipeline, follow in their original order. Only the first
 * reason of each code is kept.
 */
export function orderReasons(reasons: readonly Reason[], priority: readonly ReasonCode[]): Reason[] {
  const rank = (code: ReasonCode) => {
    const index = priority.indexOf(code);
    return index === -1 ? priority.length : index;
  };
  const seen = new Set<ReasonCode>();
  return reasons
    .filter(r => !seen.has(r.code) && seen.add(r.code))
    .map((r, index) => ({ r, index }))
    .sort((x, y) => rank(x.r.code) - rank(y.r.code) || x.index - y.index)
    .map(({ r }) => r);
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function num(n: number): string {
  return numberFormat.format(Math.round(n));
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${num(n)} ${Math.round(n) === 1 ? singular : pluralForm}`;
}

function playtime(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return plural(m, 'minute');
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  if (hours >= 10 || rest === 0) return plural(Math.round(m / 60), 'hour');
  return `${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
}

function hours(h: number): string {
  return h < 1 ? 'under an hour' : plural(h, 'hour');
}

function span(months: number): string {
  const m = Math.floor(months);
  if (m < 1) return 'a while';
  if (m < 24) return plural(m, 'month');
  const years = Math.floor(m / 12);
  return `${m % 12 === 0 ? '' : 'over '}${plural(years, 'year')}`;
}

function percent(p: number): string {
  // Floor so 99.6% never reads as finished.
  return `${Math.min(100, Math.max(0, Math.floor(p)))}%`;
}

export function renderReason(r: Reason): string {
  switch (r.code) {
    case 'random_pick':
      return 'Picked completely at random';
    case 'never_launched':
      return "You've never launched it";
    case 'barely_played':
      return `You've only played it for ${playtime(r.params.minutes)}`;
    case 'idle':
      return `You haven't played it in ${span(r.params.months)}`;
    case 'outside_rotation':
      return "It's outside your recent rotation";
    case 'comfort':
      return `An old favorite: you've put ${hours(r.params.hours)} into it`;
    case 'rediscovery':
      return `You played this for ${hours(r.params.hours)} but haven't touched it in ${span(r.params.months)}`;
    case 'ach_remaining':
      return `${num(r.params.remaining)} of ${num(r.params.total)} achievements still to unlock`;
    case 'ach_near_complete': {
      const left = r.params.remaining === 1 ? 'just 1 to go' : `${num(r.params.remaining)} to go`;
      return `You're already ${percent(r.params.percent)} through the achievements in this game (${left})`;
    }
    case 'rare_remaining':
      return r.params.count === 1
        ? `1 locked achievement is held by under ${num(r.params.threshold)}% of players`
        : `${num(r.params.count)} locked achievements are held by under ${num(r.params.threshold)}% of players`;
    case 'active_now': {
      const online = `${plural(r.params.players, 'player')} online`;
      if (r.params.band === 'high') return `Busy right now: ${online}`;
      if (r.params.band === 'low') return `Quiet right now: ${online}`;
      return `${online} right now`;
    }
    case 'friends_all_own':
      if (r.params.count === 1) return '1 player owns it';
      return r.params.count === 2 ? 'Both players own it' : `All ${num(r.params.count)} players own it`;
    case 'friends_never_played':
      return r.params.count === 1 ? '1 player has never played it' : `${num(r.params.count)} players have never played it`;
    case 'not_rolled_recently':
      return "QIT hasn't suggested it lately";
    default: {
      const unreachable: never = r;
      throw new Error(`Unknown reason ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The texts a card shows: the first `limit` reasons, which callers pass already ordered. */
export function renderReasons(reasons: readonly Reason[], limit = CARD_REASON_LIMIT): string[] {
  return reasons.slice(0, limit).map(renderReason);
}
