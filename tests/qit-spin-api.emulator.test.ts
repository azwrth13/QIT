import { Query } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORE_FLAG_BITS, storeFlag } from '../src/lib/apps/metadata';
import { db } from '../src/lib/firestore';
import { addExclusion } from '../src/lib/history/exclusions';
import { getRoll, listRolls, recordRoll } from '../src/lib/history/rolls';
import { readStats } from '../src/lib/history/stats';
import { parseSpinRequest, type ParsedSpinRequest } from '../src/lib/roulette/request';
import { previewPool, spin } from '../src/lib/roulette/service';
import type { StoreItem } from '../src/lib/steam/store';
import { patchLibIndex, readLibIndex } from '../src/lib/store/lib-index';
import { paths } from '../src/lib/store/paths';

// Emulator-only (npm run test:firestore). Skipped elsewhere so it can never touch a real project.
const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;

const { getStoreItems } = vi.hoisted(() => ({ getStoreItems: vi.fn() }));
vi.mock('../src/lib/steam/store', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/steam/store')>(), getStoreItems }));

afterEach(() => { getStoreItems.mockReset(); vi.restoreAllMocks(); });

let nextId = 0;
const freshUser = () => `7656119912${String(Date.now() % 1e5).padStart(5, '0')}${String(nextId++ % 100).padStart(2, '0')}`;
// Unique appids per run so a long-lived emulator never serves another run's appMeta cache.
const base = 5_000_000 + (Date.now() % 1_000_000) * 10;
const KNOWN = STORE_FLAG_BITS.known;

const parse = (raw: unknown, kind: 'spin' | 'pool' = 'spin'): ParsedSpinRequest => {
  const result = parseSpinRequest(raw, kind);
  if (!result.ok) throw new Error(result.error);
  return result.request;
};

function item(appid: number, type = 0): StoreItem {
  return {
    appid, name: `App ${appid}`, type, visible: true, tagids: [], tags: [],
    categories: { supported_player_categoryids: [2], feature_categoryids: [], controller_categoryids: [] },
    releaseDate: null, reviews: null, assets: { header: 'header.jpg' }, parentAppid: null,
  };
}

/** Counts document reads made through queries and getAll during `fn`. */
async function countReads<T>(fn: () => Promise<T>): Promise<{ result: T; reads: number }> {
  let reads = 0;
  const getAll = db.getAll.bind(db);
  vi.spyOn(db, 'getAll').mockImplementation(async (...refs) => { const snapshots = await getAll(...refs); reads += snapshots.length; return snapshots; });
  const get = Query.prototype.get;
  vi.spyOn(Query.prototype, 'get').mockImplementation(async function (this: Query) { const snapshot = await get.call(this); reads += Math.max(1, snapshot.size); return snapshot; });
  const result = await fn();
  vi.restoreAllMocks();
  return { result, reads };
}

describe.skipIf(!emulated)('spin pipeline against the Firestore emulator', () => {
  it('spins Pure Random over the library index, honouring vetoes, non-games and request exclusions, and records the roll', async () => {
    const steamId = freshUser();
    const [unplayed, played, software, vetoed, hidden] = [base + 10, base + 20, base + 30, base + 40, base + 50];
    await patchLibIndex(steamId, {
      [unplayed]: { n: 'Unplayed', p: 0, r: 0, f: KNOWN },
      [played]: { n: 'Played', p: 600, w: 0, r: 1_700_000_000, f: KNOWN | STORE_FLAG_BITS.coop | STORE_FLAG_BITS.multiplayer },
      [software]: { n: 'Wallpaper tool', p: 0, f: STORE_FLAG_BITS.nonGame },
      [vetoed]: { n: 'Vetoed', p: 0, f: KNOWN },
      [hidden]: { n: 'Hidden', p: 0, f: KNOWN },
    }, { create: true });
    await addExclusion(steamId, vetoed, 'forever');
    await addExclusion(steamId, hidden, 'session', { sessionId: 'picker1' });
    getStoreItems.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, item(id)] as const)));

    const rolled = new Map<number, number>();
    for (let i = 0; i < 25; i++) {
      const result = await spin(steamId, parse({ mode: 'pure-random', sessionId: 'picker1', seed: `seed-${i}` }));
      rolled.set(result.card!.appid, (rolled.get(result.card!.appid) ?? 0) + 1);
    }
    expect([...rolled.keys()].sort()).toEqual([unplayed, played]);

    const result = await spin(steamId, parse({ mode: 'pure-random', filters: [{ id: 'never-played' }], exclude: [played] }));
    expect(result.preview).toMatchObject({ total: 5, removed: { request: 1, vetoed: 1, non_game: 1 }, final: 2 });
    // Without the session id, the session-hidden game is back in the pool.
    expect([unplayed, hidden]).toContain(result.card!.appid);
    expect(result.card).toMatchObject({ modeId: 'pure-random', reasons: [{ code: 'random_pick', params: {} }] });
    expect(result.card!.previousSelections).toBe(rolled.get(result.card!.appid) ?? 0);
    expect(result.card!.art.header).toBe(`https://shared.steamstatic.com/store_item_assets/steam/apps/${result.card!.appid}/header.jpg`);
    expect(result.coverage).toEqual({ library: 1, store: 1, history: 1 });

    const roll = await getRoll(steamId, result.card!.rollId!);
    expect(roll).toMatchObject({
      appid: result.card!.appid, modeId: 'pure-random', filters: [{ id: 'never-played' }], scope: { kind: 'library' },
      participants: [steamId], playtimeAtRoll: 0, status: 'rolled', reasons: [{ code: 'random_pick', params: {} }],
    });
    expect((await listRolls(steamId, { limit: 50 })).rolls).toHaveLength(26);
    expect((await readStats(steamId)).counters).toMatchObject({ roll: 26, 'roll:modeId:pure-random': 26, exclude: 2 });
  });

  it('leaves out games rolled inside the anti-repeat window and counts previous selections', async () => {
    const steamId = freshUser();
    const [a, b] = [base + 110, base + 120];
    await patchLibIndex(steamId, { [a]: { n: 'A', p: 0, f: KNOWN }, [b]: { n: 'B', p: 0, f: KNOWN } }, { create: true });
    await recordRoll(steamId, { appid: a, modeId: 'pure-random', filters: [], scope: { kind: 'library' }, playtimeAtRoll: 0, reasons: [] }, Date.now() - 3 * 86_400_000);
    getStoreItems.mockResolvedValue(new Map());

    const first = await spin(steamId, parse({ mode: 'pure-random', filters: [{ id: 'exclude-rolled' }] }));
    expect(first.card!.appid).toBe(b);
    // Now both games were rolled inside the window.
    const none = await spin(steamId, parse({ mode: 'pure-random', filters: [{ id: 'exclude-rolled' }] }));
    expect(none).toMatchObject({ card: null, poolSize: 0 });
    // A 2-day window no longer covers the old roll of A; the roll just made for B keeps it out.
    const pool = await previewPool(steamId, parse({ filters: [{ id: 'exclude-rolled', params: { days: 2 } }] }, 'pool'));
    expect(pool.preview.steps).toEqual([{ id: 'exclude-rolled', passed: 1, failed: 1, unknown: 0, remaining: 1 }]);
    const shown = await spin(steamId, parse({ mode: 'pure-random', exclude: [a] }));
    expect(shown.card).toMatchObject({ appid: b, previousSelections: 1 });
  });

  it('fills unknown store flags into the index during a spin, but not during a pool preview', async () => {
    const steamId = freshUser();
    const [game, dlc] = [base + 210, base + 220];
    await patchLibIndex(steamId, { [game]: { n: 'Game', p: 0 }, [dlc]: { n: 'Soundtrack', p: 0 } }, { create: true });
    getStoreItems.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, item(id, id === dlc ? 11 : 0)] as const)));

    const pool = await previewPool(steamId, parse({ mode: 'pure-random' }, 'pool'));
    expect(getStoreItems).not.toHaveBeenCalled();
    expect(pool).toMatchObject({ eligible: 2, coverage: { store: 0 }, preview: { removed: { non_game: 0 } } });

    const result = await spin(steamId, parse({ mode: 'pure-random' }));
    expect(result.preview.removed.non_game).toBe(1);
    expect(result.card!.appid).toBe(game);
    expect(result.coverage.store).toBe(1);
    const { entries } = await readLibIndex(steamId);
    expect(storeFlag(entries.get(game)!.f, 'singlePlayer')).toBe(true);
    expect(entries.get(dlc)!.f! & STORE_FLAG_BITS.nonGame).toBeTruthy();
  });

  it('reads the library in a handful of documents once flags are known', async () => {
    const steamId = freshUser();
    const games = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [base + 1000 + i * 10, { n: `G${i}`, p: i, f: KNOWN }]));
    await patchLibIndex(steamId, games, { create: true });
    getStoreItems.mockResolvedValue(new Map());
    const { reads } = await countReads(() => previewPool(steamId, parse({ mode: 'pure-random' }, 'pool')));
    // The user doc, four index chunks, the exclusions doc and one empty rolls query, whatever the library size.
    expect(reads).toBe(7);
  });

  it('works for a user whose index is not built yet', async () => {
    const steamId = freshUser();
    const appid = base + 510;
    await db.doc(paths.userGame(steamId, appid)).set({ appid, name: 'Legacy', img_icon_url: '', playtime_forever: 0 });
    getStoreItems.mockResolvedValue(new Map());
    const result = await spin(steamId, parse({ mode: 'pure-random' }));
    expect(result.card).toMatchObject({ appid, name: 'Legacy' });
    expect(result.coverage.store).toBe(0);
  });
});
