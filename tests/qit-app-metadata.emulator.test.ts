import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichLibraryFlags, getAppMeta, storeFlag } from '../src/lib/apps/metadata';
import { db } from '../src/lib/firestore';
import type { StoreItem } from '../src/lib/steam/store';
import { patchLibIndex, readLibIndex } from '../src/lib/store/lib-index';
import { paths } from '../src/lib/store/paths';

// Emulator-only (npm run test:firestore). Skipped elsewhere so it can never touch a real project.
const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;

const { getStoreItems } = vi.hoisted(() => ({ getStoreItems: vi.fn() }));
vi.mock('../src/lib/steam/store', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/steam/store')>(), getStoreItems }));

afterEach(() => { getStoreItems.mockReset(); });

const freshUser = () => `7656119911${String(Date.now() % 1e7).padStart(7, '0')}`;
// Unique appids per run so repeated runs against a long-lived emulator never see each other's cache.
const base = 3_000_000 + (Date.now() % 1_000_000) * 10;

function item(appid: number, player: number[], feature: number[] = []): StoreItem {
  return {
    appid, name: `App ${appid}`, type: 0, visible: true, tagids: [19], tags: [],
    categories: { supported_player_categoryids: player, feature_categoryids: feature, controller_categoryids: [] },
    releaseDate: 1_500_000_000, reviews: null, assets: { header: 'header.jpg' }, parentAppid: null,
  };
}

describe.skipIf(!emulated)('app metadata against the Firestore emulator', () => {
  it('caches store items, negative-caches unknown apps and serves the second call without Steam', async () => {
    const [a, b] = [base + 10, base + 20];
    getStoreItems.mockResolvedValue(new Map([[a, item(a, [2, 1, 9], [22])], [b, null]]));
    const first = await getAppMeta([a, b]);
    expect(first).toMatchObject({ fetched: 2, unresolved: [] });
    expect((await db.doc(paths.appMeta(a)).get()).data()).toMatchObject({ state: 'ok', type: 'game', tagids: [19], release: 1_500_000_000 });
    expect((await db.doc(paths.appMeta(b)).get()).data()).toMatchObject({ state: 'unknown' });

    getStoreItems.mockClear();
    const second = await getAppMeta([a, b]);
    expect(getStoreItems).not.toHaveBeenCalled();
    expect(second.meta.get(a)).toMatchObject({ state: 'ok', stale: false });
    expect(second.meta.get(b)).toMatchObject({ state: 'unknown', flags: 0 });
  });

  it('patches store flags into the library index without touching other fields or missing games', async () => {
    const steamId = freshUser();
    const [a, b, gone] = [base + 30, base + 40, base + 50];
    await patchLibIndex(steamId, { [a]: { n: 'A', p: 90, r: 5 }, [b]: { n: 'B', p: 0 } }, { create: true });
    getStoreItems.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, id === b ? null : item(id, [1, 36], [22])] as const)));

    const result = await enrichLibraryFlags(steamId);
    expect(result).toMatchObject({ requested: 2, fetched: 2, patched: 2, unresolved: 0, coverage: 0.5 });
    const { entries } = await readLibIndex(steamId);
    expect(entries.get(a)).toMatchObject({ n: 'A', p: 90, r: 5 });
    expect(storeFlag(entries.get(a)!.f, 'pvp')).toBe(true);
    expect(storeFlag(entries.get(a)!.f, 'coop')).toBe(false);
    expect(entries.get(b)).toEqual({ n: 'B', p: 0, f: 0 });
    expect(entries.has(gone)).toBe(false);

    // Nothing left to do for A; only the unknown app is rechecked, from the negative cache, without a Steam call.
    getStoreItems.mockClear();
    expect(await enrichLibraryFlags(steamId)).toMatchObject({ requested: 1, fetched: 0, patched: 1, unresolved: 0 });
    expect(getStoreItems).not.toHaveBeenCalled();
  });

  it('does not resurrect an app the library sync removed while metadata was loading', async () => {
    const steamId = freshUser();
    const [a, b] = [base + 60, base + 70];
    await patchLibIndex(steamId, { [a]: { n: 'A' }, [b]: { n: 'B' } }, { create: true });
    getStoreItems.mockImplementation(async (ids: number[]) => {
      // The sync drops B between the index read and the flag patch.
      const { removeFromLibIndex } = await import('../src/lib/store/lib-index');
      await removeFromLibIndex(steamId, [b]);
      return new Map(ids.map(id => [id, item(id, [2])] as const));
    });
    const result = await enrichLibraryFlags(steamId);
    expect(result.patched).toBe(1);
    expect((await readLibIndex(steamId)).entries.has(b)).toBe(false);
  });
});
