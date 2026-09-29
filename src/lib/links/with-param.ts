import { isSteamId } from '../steam';

// URL contract for handing a friend selection between pages: `/friend-night?with=id1,id2`.
// Pages read it with `parseWithParam` and link with `withHref`; nothing else should build `with` by hand.

export const WITH_PARAM = 'with';
/** Upper bound on ids read from one URL, so a crafted link cannot fan out into unbounded Steam lookups. */
export const MAX_WITH_IDS = 16;

type ParamValue = string | string[] | null | undefined;

/**
 * Reads Steam IDs from a `with` value (a string, repeated params from Next `searchParams`, or
 * `URLSearchParams.get`). Invalid entries, duplicates and `self` are dropped; order is kept.
 */
export function parseWithParam(value: ParamValue, options: { self?: string } = {}): string[] {
  const raw = (Array.isArray(value) ? value : [value ?? '']).flatMap(part => part.split(','));
  const ids: string[] = [];
  for (const entry of raw) {
    const id = entry.trim();
    if (isSteamId(id) && id !== options.self && !ids.includes(id)) ids.push(id);
    if (ids.length === MAX_WITH_IDS) break;
  }
  return ids;
}

/** `withHref('/friend-night', ['1', '2'])` -> `/friend-night?with=1,2`; other query params and the hash survive. */
export function withHref(path: string, ids: readonly string[]): string {
  const url = new URL(path, 'http://qit.invalid');
  const selected = parseWithParam(ids.join(','));
  if (selected.length) url.searchParams.set(WITH_PARAM, selected.join(','));
  else url.searchParams.delete(WITH_PARAM);
  // Steam IDs are digits, so the only escaping URLSearchParams adds to `with` is the comma.
  return `${url.pathname}${url.search.replace(/%2C/gi, ',')}${url.hash}`;
}
