import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreItem } from '../src/lib/steam/store';

const { docs, getStoreItems, readLibIndex, patchLibIndex } = vi.hoisted(() => ({
  docs: new Map<string, unknown>(),
  getStoreItems: vi.fn(),
  readLibIndex: vi.fn(),
  patchLibIndex: vi.fn(),
}));

vi.mock('../src/lib/firestore', () => {
  const ref = (path: string) => ({ path, withConverter() { return this; } });
  return {
    db: {
      doc: ref,
      getAll: async (...refs: Array<{ path: string }>) => refs.map(r => ({ data: () => docs.get(r.path) })),
      batch: () => {
        const pending: Array<() => void> = [];
        return { set: (r: { path: string }, value: unknown) => { pending.push(() => docs.set(r.path, value)); }, commit: async () => pending.forEach(fn => fn()) };
      },
    },
  };
});
vi.mock('../src/lib/steam/store', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/steam/store')>(), getStoreItems }));
vi.mock('../src/lib/store/lib-index', () => ({ readLibIndex, patchLibIndex }));

import {
  APP_META_NEGATIVE_TTL_MS, APP_META_TTL_MS, FILTERABLE_FLAGS, STORE_FLAG_BITS, appArtUrl, decodeStoreFlags, encodeStoreFlags,
  enrichLibraryFlags, getAppMeta, isAppMetaFresh, isNonGame, matchesFlags, pickArt, storeFlag, storeItemType, storeSignalsOf,
  toAppMetaRecord, unknownAppMetaRecord,
} from '../src/lib/apps/metadata';

const NOW = 1_800_000_000_000;

function item(appid: number, over: Partial<StoreItem> & { player?: number[]; feature?: number[] } = {}): StoreItem {
  const { player = [2], feature = [22], ...rest } = over;
  return {
    appid, name: `App ${appid}`, type: 0, visible: true, tagids: [19, 21], tags: [],
    categories: { supported_player_categoryids: player, feature_categoryids: feature, controller_categoryids: [28] },
    releaseDate: 1_303_186_800,
    reviews: { review_count: 100, percent_positive: 98, review_score: 9, review_score_label: 'Overwhelmingly Positive' },
    assets: { asset_url_format: 'steam/apps/1/${FILENAME}?t=1', header: 'abc/header.jpg', library_capsule: 'library_600x900.jpg', community_icon: 'deadbeef', last_modified: 5 },
    parentAppid: null,
    ...rest,
  };
}

const answer = (items: Array<StoreItem | number>) =>
  new Map(items.map(entry => typeof entry === 'number' ? [entry, null] as const : [entry.appid, entry] as const));

beforeEach(() => {
  docs.clear();
  getStoreItems.mockReset();
  readLibIndex.mockReset();
  patchLibIndex.mockReset();
});

describe('store flag bits', () => {
  it('maps live category ids: Portal 2 is single, multi, co-op and has achievements, but not PvP', () => {
    const bits = encodeStoreFlags(item(620, { player: [2, 1, 9, 38, 39, 24], feature: [22, 29] }));
    expect(decodeStoreFlags(bits)).toEqual({ singlePlayer: true, multiplayer: true, coop: true, pvp: false, mmo: false, achievements: true });
  });

  it('recognises PvP, MMO and co-op variants, and implies multiplayer', () => {
    expect(storeFlag(encodeStoreFlags(item(1, { player: [49], feature: [] })), 'pvp')).toBe(true);
    expect(storeFlag(encodeStoreFlags(item(1, { player: [49], feature: [] })), 'multiplayer')).toBe(true);
    expect(storeFlag(encodeStoreFlags(item(1, { player: [48], feature: [] })), 'coop')).toBe(true);
    const mmo = encodeStoreFlags(item(1, { player: [20], feature: [] }));
    expect(storeFlag(mmo, 'mmo')).toBe(true);
    expect(storeFlag(mmo, 'multiplayer')).toBe(true);
    expect(storeFlag(mmo, 'singlePlayer')).toBe(false);
  });

  it('treats no category data as unknown, not false', () => {
    const bits = encodeStoreFlags(item(1, { player: [], feature: [] }));
    expect(bits).toBe(0);
    expect(Object.values(decodeStoreFlags(bits))).toEqual([null, null, null, null, null, null]);
    expect(Object.values(decodeStoreFlags(undefined))).toEqual([null, null, null, null, null, null]);
    expect(matchesFlags(bits, ['coop'])).toBe(false);
  });

  it('marks non-games only when the type is known', () => {
    expect(isNonGame(encodeStoreFlags(item(1, { type: 11 })))).toBe(true);
    expect(isNonGame(encodeStoreFlags(item(1, { type: 0 })))).toBe(false);
    expect(isNonGame(encodeStoreFlags(item(1, { type: null })))).toBe(false);
    expect(isNonGame(undefined)).toBe(false);
    // A non-game with no categories keeps its type bit but its flags stay unknown.
    const bits = encodeStoreFlags(item(1, { type: 6, player: [], feature: [] }));
    expect(isNonGame(bits)).toBe(true);
    expect(storeFlag(bits, 'coop')).toBeNull();
  });

  it('gives every filterable flag its own bit and matches on all wanted flags', () => {
    const bits = FILTERABLE_FLAGS.map(flag => flag.bit);
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) expect(Number.isInteger(Math.log2(bit))).toBe(true);
    expect(bits.every(bit => bit !== STORE_FLAG_BITS.known && bit !== STORE_FLAG_BITS.nonGame)).toBe(true);
    const coopAchievements = encodeStoreFlags(item(1, { player: [1, 9], feature: [22] }));
    expect(matchesFlags(coopAchievements, ['coop', 'achievements'])).toBe(true);
    expect(matchesFlags(coopAchievements, ['coop', 'pvp'])).toBe(false);
  });
});

describe('records', () => {
  it('names item types and keeps unmapped ones', () => {
    expect([0, 4, 6, 11, 14, null].map(storeItemType)).toEqual(['game', 'dlc', 'software', 'music', 'type14', undefined]);
  });

  it('keeps only the art files QIT uses and builds CDN urls from them', () => {
    expect(pickArt(item(1).assets)).toEqual({ header: 'abc/header.jpg', library_capsule: 'library_600x900.jpg', community_icon: 'deadbeef' });
    expect(pickArt(null)).toBeUndefined();
    expect(pickArt({ header: '../x/header.jpg' })).toBeUndefined();
    const art = { header: 'abc/header.jpg', community_icon: 'deadbeef' };
    expect(appArtUrl(620, art, 'header')).toBe('https://shared.steamstatic.com/store_item_assets/steam/apps/620/abc/header.jpg');
    expect(appArtUrl(620, art, 'community_icon')).toBeNull();
    expect(appArtUrl(620, art, 'library_hero')).toBeNull();
  });

  it('builds the cached document without empty fields', () => {
    const record = toAppMetaRecord(item(620, { player: [2, 1], feature: [22], parentAppid: 5 }), NOW);
    expect(record).toMatchObject({
      state: 'ok', type: 'game', tagids: [19, 21], release: 1_303_186_800, review: 9, reviewPercent: 98, reviewCount: 100,
      parentAppid: 5, categories: [2, 1, 22, 28],
    });
    expect(record.fetchedAt.toMillis()).toBe(NOW);
    const bare = toAppMetaRecord(item(1, { type: null, tagids: [], releaseDate: null, reviews: null, assets: null, player: [], feature: [],
      categories: { supported_player_categoryids: [], feature_categoryids: [], controller_categoryids: [] } }), NOW);
    expect(Object.keys(bare).sort()).toEqual(['fetchedAt', 'flags', 'state']);
  });

  it('expires ok entries after 7 days and negative ones after 30', () => {
    const ok = toAppMetaRecord(item(1), NOW);
    expect(isAppMetaFresh(ok, NOW + APP_META_TTL_MS - 1)).toBe(true);
    expect(isAppMetaFresh(ok, NOW + APP_META_TTL_MS)).toBe(false);
    const unknown = unknownAppMetaRecord(NOW);
    expect(isAppMetaFresh(unknown, NOW + APP_META_TTL_MS)).toBe(true);
    expect(isAppMetaFresh(unknown, NOW + APP_META_NEGATIVE_TTL_MS)).toBe(false);
    expect(isAppMetaFresh({ state: 'ok', fetchedAt: 'x' as never }, NOW)).toBe(false);
  });
});

describe('getAppMeta', () => {
  it('fetches missing apps once, caches them, and negative-caches apps Steam does not know', async () => {
    getStoreItems.mockResolvedValue(answer([item(620), 228980]));
    const first = await getAppMeta([620, 228980, 620], { now: NOW });
    expect(getStoreItems).toHaveBeenCalledTimes(1);
    expect(getStoreItems.mock.calls[0][0]).toEqual([620, 228980]);
    expect(first).toMatchObject({ unresolved: [], fetched: 2 });
    expect(first.meta.get(620)).toMatchObject({ state: 'ok', type: 'game', stale: false });
    expect(first.meta.get(228980)).toMatchObject({ state: 'unknown', flags: 0 });
    expect(docs.get('appMeta/228980')).toMatchObject({ state: 'unknown' });

    const second = await getAppMeta([620, 228980], { now: NOW + 1000 });
    expect(getStoreItems).toHaveBeenCalledTimes(1);
    expect(second.fetched).toBe(0);
    expect(second.meta.size).toBe(2);
  });

  it('batches 100 apps per Steam call and honours maxFetch', async () => {
    getStoreItems.mockImplementation(async (ids: number[]) => answer(ids.map(id => item(id))));
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const result = await getAppMeta(ids, { now: NOW, maxFetch: 210 });
    expect(getStoreItems.mock.calls.map(call => call[0].length).sort((a, b) => a - b)).toEqual([10, 100, 100]);
    expect(result.fetched).toBe(210);
    expect(result.unresolved).toEqual(ids.slice(210));
    expect(docs.size).toBe(210);
  });

  it('does not cache a failed batch as unknown, and reports it unresolved', async () => {
    getStoreItems.mockRejectedValue(new Error('rate_limited'));
    const result = await getAppMeta([620], { now: NOW });
    expect(result.unresolved).toEqual([620]);
    expect(result.meta.size).toBe(0);
    expect(docs.size).toBe(0);
  });

  it('serves the expired copy when the refresh fails', async () => {
    docs.set('appMeta/620', toAppMetaRecord(item(620), NOW - APP_META_TTL_MS - 1));
    getStoreItems.mockRejectedValue(new Error('unavailable'));
    const result = await getAppMeta([620], { now: NOW });
    expect(result.unresolved).toEqual([]);
    expect(result.meta.get(620)).toMatchObject({ state: 'ok', stale: true });
  });

  it('refetches expired entries and everything when forced', async () => {
    docs.set('appMeta/1', toAppMetaRecord(item(1), NOW - APP_META_TTL_MS - 1));
    docs.set('appMeta/2', toAppMetaRecord(item(2), NOW));
    getStoreItems.mockImplementation(async (ids: number[]) => answer(ids.map(id => item(id))));
    await getAppMeta([1, 2], { now: NOW });
    expect(getStoreItems.mock.calls.map(call => call[0])).toEqual([[1]]);
    getStoreItems.mockClear();
    await getAppMeta([1, 2], { now: NOW, force: true });
    expect(getStoreItems.mock.calls[0][0]).toEqual([1, 2]);
  });

  it('ignores malformed cached documents and refetches them', async () => {
    docs.set('appMeta/1', { state: 'weird', fetchedAt: Timestamp.fromMillis(NOW) });
    getStoreItems.mockResolvedValue(answer([item(1)]));
    expect((await getAppMeta([1], { now: NOW })).fetched).toBe(1);
  });

  it('rejects invalid app ids before reading', async () => {
    await expect(getAppMeta([0])).rejects.toThrow('Invalid app ID');
  });
});

describe('enrichLibraryFlags', () => {
  const entries = (list: Array<[number, number | undefined]>) =>
    new Map(list.map(([appid, f]) => [appid, { n: `App ${appid}`, ...(f === undefined ? {} : { f }) }]));

  it('patches f only for entries without known flags, with 0 for unknown apps, skipping settled ones', async () => {
    const known = encodeStoreFlags(item(2));
    readLibIndex.mockResolvedValue({ entries: entries([[1, undefined], [2, known], [3, undefined], [4, 0]]), built: true, updatedAt: null });
    getStoreItems.mockResolvedValue(answer([item(1, { player: [1, 36], feature: [] }), 3, 4]));
    patchLibIndex.mockImplementation(async (_id: string, patches: Map<number, unknown>) => ({ applied: [...patches.keys()], skipped: [] }));

    const result = await enrichLibraryFlags('76561198000000042', { now: NOW });
    expect(getStoreItems.mock.calls[0][0]).toEqual([1, 3, 4]);
    const patches = patchLibIndex.mock.calls[0][1] as Map<number, { f: number }>;
    expect([...patches.keys()]).toEqual([1, 3]);
    expect(storeFlag(patches.get(1)!.f, 'pvp')).toBe(true);
    expect(patches.get(3)).toEqual({ f: 0 });
    expect(result).toEqual({ requested: 3, fetched: 3, patched: 2, unresolved: 0, coverage: 0.5 });
  });

  it('does not touch the index when Steam is unreachable, and reports coverage', async () => {
    readLibIndex.mockResolvedValue({ entries: entries([[1, undefined], [2, encodeStoreFlags(item(2))]]), built: true, updatedAt: null });
    getStoreItems.mockRejectedValue(new Error('unavailable'));
    patchLibIndex.mockResolvedValue({ applied: [], skipped: [] });
    const result = await enrichLibraryFlags('76561198000000042', { now: NOW });
    expect([...(patchLibIndex.mock.calls[0][1] as Map<number, unknown>).keys()]).toEqual([]);
    expect(result).toEqual({ requested: 1, fetched: 0, patched: 0, unresolved: 1, coverage: 0.5 });
  });

  it('never overwrites known flags with unknown when forced', async () => {
    const known = encodeStoreFlags(item(1));
    readLibIndex.mockResolvedValue({ entries: entries([[1, known]]), built: true, updatedAt: null });
    getStoreItems.mockResolvedValue(answer([1].map(() => 1)));
    patchLibIndex.mockResolvedValue({ applied: [], skipped: [] });
    await enrichLibraryFlags('76561198000000042', { now: NOW, force: true });
    expect([...(patchLibIndex.mock.calls[0][1] as Map<number, unknown>).keys()]).toEqual([]);
  });

  it('never overwrites known flags with an ok answer that has no category data when forced', async () => {
    const known = encodeStoreFlags(item(1));
    readLibIndex.mockResolvedValue({ entries: entries([[1, known]]), built: true, updatedAt: null });
    getStoreItems.mockResolvedValue(answer([item(1, { player: [], feature: [] })]));
    patchLibIndex.mockResolvedValue({ applied: [], skipped: [] });
    await enrichLibraryFlags('76561198000000042', { now: NOW, force: true });
    expect([...(patchLibIndex.mock.calls[0][1] as Map<number, unknown>).keys()]).toEqual([]);
  });

  it('handles an empty or unbuilt library without calling Steam', async () => {
    readLibIndex.mockResolvedValue({ entries: new Map(), built: false, updatedAt: null });
    patchLibIndex.mockResolvedValue({ applied: [], skipped: [] });
    expect(await enrichLibraryFlags('76561198000000042')).toEqual({ requested: 0, fetched: 0, patched: 0, unresolved: 0, coverage: 1 });
    expect(getStoreItems).not.toHaveBeenCalled();
  });
});

describe('storeSignalsOf', () => {
  it('shapes roulette store signals and keeps unknown apps unknown', async () => {
    getStoreItems.mockResolvedValue(answer([item(620, { player: [2, 9] }), 999]));
    const { meta } = await getAppMeta([620, 999], { now: NOW });
    expect(storeSignalsOf(meta.get(620))).toEqual({
      type: 'game', flags: { singlePlayer: true, multiplayer: true, coop: true, pvp: false, mmo: false, achievements: true },
      releasedAt: 1_303_186_800, tagIds: [19, 21], headerArt: 'https://shared.steamstatic.com/store_item_assets/steam/apps/620/abc/header.jpg',
    });
    expect(storeSignalsOf(meta.get(999))).toEqual({
      type: null, flags: { singlePlayer: null, multiplayer: null, coop: null, pvp: null, mmo: null, achievements: null },
      releasedAt: null, tagIds: [], headerArt: null,
    });
    expect(storeSignalsOf(undefined).type).toBeNull();
  });
});
