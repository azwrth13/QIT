import { Timestamp, type WriteBatch } from 'firebase-admin/firestore';
import { db } from '../firestore';
import type { StoreFlag, StoreSignals } from '../roulette/types';
import type { SteamClient } from '../steam/client';
import { getStoreItems, STORE_ITEMS_BATCH, type StoreItem } from '../steam/store';
import { recordConverter } from '../store/converters';
import { patchLibIndex, readLibIndex } from '../store/lib-index';
import { paths } from '../store/paths';
import { commitInBatches, getAllInGroups } from '../store/tx';
import type { AppMetaRecord } from '../store/types';

// Store metadata (categories, tags, type, release, art, reviews) cached in `appMeta/{appid}` and filled by
// batched `IStoreBrowseService/GetItems` (100 apps per call). The compact store flag bits are also patched into
// the user's library index (`f`), so filters read them with the four index reads and no per-app documents.
// `apps/{appid}` (genre-cache.ts) is never touched: it is overwritten with plain `set`.
//
// Unknown is a state, not false: an app Steam has nothing on gets a negative cache entry (`state: 'unknown'`),
// and every flag of it decodes to `null`.

/** Fresh metadata is reused for 7 days, a negative entry for 30 (report section 3). */
export const APP_META_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const APP_META_NEGATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Steam store category ids, verified against live GetItems answers (Portal 2, Destiny 2, Stardew Valley, ...).
const CATEGORY = {
  multiPlayer: 1, singlePlayer: 2, coop: 9, mmo: 20, achievements: 22,
  onlinePvp: 36, sharedPvp: 37, onlineCoop: 38, sharedCoop: 39, lanPvp: 47, lanCoop: 48, pvp: 49,
} as const;
const COOP_CATEGORIES: readonly number[] = [CATEGORY.coop, CATEGORY.onlineCoop, CATEGORY.sharedCoop, CATEGORY.lanCoop];
const PVP_CATEGORIES: readonly number[] = [CATEGORY.pvp, CATEGORY.onlinePvp, CATEGORY.sharedPvp, CATEGORY.lanPvp];

/**
 * Bits of the `f` field in a library index entry. `KNOWN` is set when Steam gave category data; without it every
 * store flag is unknown (`f: 0` records "checked, nothing known", while a missing `f` means "not checked yet").
 * `NON_GAME` is set only when the item type is known and is not a game (feature 17 hides those by default).
 */
export const STORE_FLAG_BITS = {
  known: 1 << 0,
  singlePlayer: 1 << 1,
  multiplayer: 1 << 2,
  coop: 1 << 3,
  pvp: 1 << 4,
  mmo: 1 << 5,
  achievements: 1 << 6,
  nonGame: 1 << 7,
} as const;

/** The flags a filter can select on (feature 18), with the bit each one owns. */
export const FILTERABLE_FLAGS: ReadonlyArray<{ id: StoreFlag; label: string; bit: number }> = [
  { id: 'singlePlayer', label: 'Single-player', bit: STORE_FLAG_BITS.singlePlayer },
  { id: 'multiplayer', label: 'Multiplayer', bit: STORE_FLAG_BITS.multiplayer },
  { id: 'coop', label: 'Co-op', bit: STORE_FLAG_BITS.coop },
  { id: 'pvp', label: 'PvP', bit: STORE_FLAG_BITS.pvp },
  { id: 'mmo', label: 'MMO', bit: STORE_FLAG_BITS.mmo },
  { id: 'achievements', label: 'Has achievements', bit: STORE_FLAG_BITS.achievements },
];

/** Item types seen in live GetItems answers; anything else is kept as `type<N>` so no information is lost. */
const TYPE_NAMES: Record<number, string> = { 0: 'game', 1: 'demo', 2: 'tool', 4: 'dlc', 6: 'software', 11: 'music' };

export function storeItemType(type: number | null): string | undefined {
  return type === null ? undefined : TYPE_NAMES[type] ?? `type${type}`;
}

/** Encodes a resolved store item. Returns 0 (no known flags) when Steam gave no category data at all. */
export function encodeStoreFlags(item: Pick<StoreItem, 'type' | 'categories'>): number {
  const ids = new Set([...item.categories.supported_player_categoryids, ...item.categories.feature_categoryids]);
  const nonGame = item.type !== null && item.type !== 0 ? STORE_FLAG_BITS.nonGame : 0;
  if (!ids.size) return nonGame;
  const has = (list: readonly number[]) => list.some(id => ids.has(id));
  const coop = has(COOP_CATEGORIES);
  const pvp = has(PVP_CATEGORIES);
  const mmo = ids.has(CATEGORY.mmo);
  let bits = STORE_FLAG_BITS.known | nonGame;
  if (ids.has(CATEGORY.singlePlayer)) bits |= STORE_FLAG_BITS.singlePlayer;
  // Co-op, PvP and MMO games are multiplayer even when Steam omits the generic category.
  if (ids.has(CATEGORY.multiPlayer) || coop || pvp || mmo) bits |= STORE_FLAG_BITS.multiplayer;
  if (coop) bits |= STORE_FLAG_BITS.coop;
  if (pvp) bits |= STORE_FLAG_BITS.pvp;
  if (mmo) bits |= STORE_FLAG_BITS.mmo;
  if (ids.has(CATEGORY.achievements)) bits |= STORE_FLAG_BITS.achievements;
  return bits;
}

const isKnown = (bits: number | null | undefined): bits is number => typeof bits === 'number' && (bits & STORE_FLAG_BITS.known) !== 0;

/** One flag from the `f` bits: true, false, or null when the flags are unknown (never checked, or no data). */
export function storeFlag(bits: number | null | undefined, flag: StoreFlag): boolean | null {
  return isKnown(bits) ? (bits & STORE_FLAG_BITS[flag]) !== 0 : null;
}

export function decodeStoreFlags(bits: number | null | undefined): Record<StoreFlag, boolean | null> {
  return Object.fromEntries(FILTERABLE_FLAGS.map(({ id }) => [id, storeFlag(bits, id)])) as Record<StoreFlag, boolean | null>;
}

/** True only when the type is known and is not a game; unknown apps are never hidden as non-games. */
export function isNonGame(bits: number | null | undefined): boolean {
  return typeof bits === 'number' && (bits & STORE_FLAG_BITS.nonGame) !== 0;
}

/** Does an index entry's `f` satisfy every wanted flag? Unknown flags never match (callers decide how to treat unknown). */
export function matchesFlags(bits: number | null | undefined, wanted: readonly StoreFlag[]): boolean {
  return wanted.every(flag => storeFlag(bits, flag) === true);
}

/** Asset keys kept from `GetItems`. Values are Steam's file names, either `header.jpg` or `<hash>/header.jpg`. */
const ART_KEYS = ['header', 'main_capsule', 'small_capsule', 'library_capsule', 'library_hero', 'community_icon'] as const;

export function pickArt(assets: StoreItem['assets']): Record<string, string> | undefined {
  if (!assets) return undefined;
  const art: Record<string, string> = {};
  for (const key of ART_KEYS) {
    const value = assets[key];
    if (typeof value === 'string' && value && !value.includes('..')) art[key] = value;
  }
  return Object.keys(art).length ? art : undefined;
}

/** Store CDN URL for a stored art file (`art.header`, ...). `community_icon` is a bare hash and lives elsewhere. */
export function appArtUrl(appid: number, art: AppMetaRecord['art'] | undefined, key: typeof ART_KEYS[number]): string | null {
  const file = art?.[key];
  if (!file || key === 'community_icon' || !Number.isSafeInteger(appid) || appid <= 0) return null;
  return `https://shared.steamstatic.com/store_item_assets/steam/apps/${appid}/${file}`;
}

/** The cached document for a resolved store item. */
export function toAppMetaRecord(item: StoreItem, now = Date.now()): AppMetaRecord {
  const record: AppMetaRecord = { state: 'ok', flags: encodeStoreFlags(item), fetchedAt: Timestamp.fromMillis(now) };
  const type = storeItemType(item.type);
  if (type) record.type = type;
  const categories = [...new Set([
    ...item.categories.supported_player_categoryids, ...item.categories.feature_categoryids, ...item.categories.controller_categoryids,
  ])];
  if (categories.length) record.categories = categories;
  if (item.tagids.length) record.tagids = item.tagids;
  if (item.releaseDate) record.release = item.releaseDate;
  const art = pickArt(item.assets);
  if (art) record.art = art;
  if (item.reviews) {
    if (Number.isFinite(item.reviews.review_score)) record.review = item.reviews.review_score;
    if (Number.isFinite(item.reviews.percent_positive)) record.reviewPercent = item.reviews.percent_positive;
    if (Number.isFinite(item.reviews.review_count)) record.reviewCount = item.reviews.review_count;
  }
  if (item.parentAppid) record.parentAppid = item.parentAppid;
  return record;
}

/** The negative entry for an app Steam has no metadata on (`success: 15`: delisted, hidden or unknown). */
export function unknownAppMetaRecord(now = Date.now()): AppMetaRecord {
  return { state: 'unknown', fetchedAt: Timestamp.fromMillis(now) };
}

export function isAppMetaFresh(record: Pick<AppMetaRecord, 'state' | 'fetchedAt'>, now = Date.now()): boolean {
  if (!(record.fetchedAt instanceof Timestamp)) return false;
  return now - record.fetchedAt.toMillis() < (record.state === 'unknown' ? APP_META_NEGATIVE_TTL_MS : APP_META_TTL_MS);
}

/** What callers get back. `flags` is the `f` value to index: 0 for an unknown app, never undefined. */
export interface AppMeta extends Omit<AppMetaRecord, 'fetchedAt' | 'flags'> {
  appid: number;
  flags: number;
  fetchedAt: Date;
  /** true when a refresh failed and this is the expired copy */
  stale: boolean;
}

function toAppMeta(appid: number, record: AppMetaRecord, stale: boolean): AppMeta {
  const { fetchedAt, flags, ...rest } = record;
  return { ...rest, appid, flags: record.state === 'ok' && typeof flags === 'number' ? flags : 0, fetchedAt: fetchedAt.toDate(), stale };
}

/** The roulette's store signals for one app. Unknown apps have `type: null`, all flags null, no art. */
export function storeSignalsOf(meta: AppMeta | undefined): StoreSignals {
  const ok = meta?.state === 'ok';
  return {
    type: ok ? meta.type ?? null : null,
    flags: decodeStoreFlags(meta?.flags),
    releasedAt: ok ? meta.release ?? null : null,
    tagIds: ok ? meta.tagids ?? [] : [],
    headerArt: ok && meta ? appArtUrl(meta.appid, meta.art, 'header') : null,
  };
}

const metaRef = (appid: number) => db.doc(paths.appMeta(appid)).withConverter(recordConverter<AppMetaRecord>());

export interface AppMetaOptions {
  /** Fetch at most this many missing or expired apps from Steam (bounded enrichment); the rest come back in `unresolved`. */
  maxFetch?: number;
  /** Ignore cached copies and refetch. */
  force?: boolean;
  client?: SteamClient;
  now?: number;
}

export interface AppMetaResult {
  /** Every app with a usable answer: fresh, just fetched, or an expired copy kept because the refresh failed. */
  meta: Map<number, AppMeta>;
  /** Apps with no answer: over `maxFetch`, or their Steam batch failed and no cached copy exists. Nothing was cached for them. */
  unresolved: number[];
  fetched: number;
}

/**
 * Cached store metadata for `appids`: one `appMeta` read each, then one batched `GetItems` per 100 missing or expired
 * apps. Steam answers are cached (a negative entry when Steam has nothing); a failed batch caches nothing, so a
 * transient error is never remembered as "unknown".
 */
export async function getAppMeta(appids: readonly number[], options: AppMetaOptions = {}): Promise<AppMetaResult> {
  const now = options.now ?? Date.now();
  const unique = [...new Set(appids)];
  const snapshots = await getAllInGroups(unique.map(appid => metaRef(appid)));
  const meta = new Map<number, AppMeta>();
  const cached = new Map<number, AppMetaRecord>();
  const stale: number[] = [];
  unique.forEach((appid, index) => {
    const record = snapshots[index].data() as AppMetaRecord | undefined;
    if (!record || (record.state !== 'ok' && record.state !== 'unknown')) { stale.push(appid); return; }
    cached.set(appid, record);
    if (!options.force && isAppMetaFresh(record, now)) meta.set(appid, toAppMeta(appid, record, false));
    else stale.push(appid);
  });

  const wanted = stale.slice(0, options.maxFetch ?? stale.length);
  const unresolved = new Set(stale);
  const writes: Array<(batch: WriteBatch) => void> = [];
  let fetched = 0;
  const batches: number[][] = [];
  for (let offset = 0; offset < wanted.length; offset += STORE_ITEMS_BATCH) batches.push(wanted.slice(offset, offset + STORE_ITEMS_BATCH));
  await Promise.all(batches.map(async batch => {
    let items: Map<number, StoreItem | null>;
    try { items = await getStoreItems(batch, {}, options.client); } catch { return; }
    for (const appid of batch) {
      const item = items.get(appid) ?? null;
      const record = item ? toAppMetaRecord(item, now) : unknownAppMetaRecord(now);
      meta.set(appid, toAppMeta(appid, record, false));
      unresolved.delete(appid);
      fetched++;
      writes.push(write => write.set(metaRef(appid), record));
    }
  }));
  // A refresh that failed keeps serving the expired copy rather than nothing.
  for (const appid of [...unresolved]) {
    const record = cached.get(appid);
    if (record) { meta.set(appid, toAppMeta(appid, record, true)); unresolved.delete(appid); }
  }
  await commitInBatches(writes);
  return { meta, unresolved: [...unresolved], fetched };
}

export interface EnrichOptions extends AppMetaOptions {
  /** Only consider these library apps, in this order (every index entry when omitted); bounds the `appMeta` reads. */
  appids?: readonly number[];
}

export interface EnrichResult {
  /** Library apps whose flags were not known yet. */
  requested: number;
  fetched: number;
  /** Index entries that received `f`. */
  patched: number;
  /** Apps still without an answer; call again to continue. */
  unresolved: number;
  /** Share of the library whose flags are known after this run (0-1); 1 for an empty library. */
  coverage: number;
}

/**
 * Fills the store flag bits (`f`) of the user's library index for entries that have none or only unknown ones.
 * Apps Steam knows nothing about get `f: 0` (checked, unknown). It only patches entries that already exist in the
 * index, so it can never resurrect a game the library sync removed. Safe to call repeatedly; use `maxFetch` to bound
 * the Steam calls per request and repeat until `unresolved` is 0.
 */
export async function enrichLibraryFlags(steamId: string, options: EnrichOptions = {}): Promise<EnrichResult> {
  const index = await readLibIndex(steamId);
  const total = index.entries.size;
  const candidates = options.appids ?? [...index.entries.keys()];
  const needed = candidates.filter(appid => index.entries.has(appid) && (options.force || !isKnown(index.entries.get(appid)!.f)));
  const { meta, unresolved, fetched } = await getAppMeta(needed, options);
  const patches = new Map<number, { f: number }>();
  for (const [appid, app] of meta) {
    // An expired copy is still better than no flags, but unknown flags must not overwrite flags already known,
    // and an entry that already holds these flags needs no write.
    const current = index.entries.get(appid)?.f;
    if (app.flags === current || (!isKnown(app.flags) && isKnown(current))) continue;
    patches.set(appid, { f: app.flags });
  }
  const { applied } = await patchLibIndex(steamId, patches);
  const known = [...index.entries].filter(([appid, entry]) => isKnown(entry.f) || (patches.get(appid) && isKnown(patches.get(appid)!.f))).length;
  return { requested: needed.length, fetched, patched: applied.length, unresolved: unresolved.length, coverage: total ? known / total : 1 };
}
