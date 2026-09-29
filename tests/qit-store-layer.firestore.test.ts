import { DocumentReference, Query, Transaction } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/firestore';
import { libIndexChunkOf, patchLibIndex, readLibIndex, removeFromLibIndex, type LibIndexPatch } from '../src/lib/store/lib-index';
import { MAX_DOCUMENT_BYTES, MAX_INDEX_ENTRIES, documentSize, estimateIndexEntries } from '../src/lib/store/limits';
import { paths } from '../src/lib/store/paths';

// Emulator-only (npm run test:firestore). Skipped elsewhere so it can never touch a real project.
const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;

let nextId = 0;
const freshUser = () => `7656119900${String(Date.now() % 1e5).padStart(5, '0')}${String(nextId++ % 100).padStart(2, '0')}`;

afterEach(() => { vi.restoreAllMocks(); });

function countReads() {
  let reads = 0;
  const getAll = db.getAll.bind(db);
  vi.spyOn(db, 'getAll').mockImplementation((...refs) => { reads += refs.length; return getAll(...refs); });
  const docGet = DocumentReference.prototype.get;
  vi.spyOn(DocumentReference.prototype, 'get').mockImplementation(function (this: DocumentReference) { reads++; return docGet.call(this); });
  const queryGet = Query.prototype.get;
  vi.spyOn(Query.prototype, 'get').mockImplementation(async function (this: Query) {
    const snapshot = await queryGet.call(this);
    reads += Math.max(1, snapshot.size);
    return snapshot;
  });
  const txGetAll = Transaction.prototype.getAll;
  vi.spyOn(Transaction.prototype, 'getAll').mockImplementation(function (this: Transaction, ...refs) {
    reads += refs.length;
    return txGetAll.apply(this, refs as never);
  });
  return () => reads;
}

// Deterministic PRNG so the synthetic library is the same on every run.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Realistic shape: almost every Steam appid is a multiple of 10. Every field is populated. */
function syntheticLibrary(size: number): Map<number, LibIndexPatch> {
  const rand = random(8000);
  const library = new Map<number, LibIndexPatch>();
  const words = ['Legend', 'Chronicles', 'Simulator', 'Édition', 'Définitive', 'Space', 'Dungeon', 'Tactics', '™', 'Remastered', 'of the', 'Night'];
  while (library.size < size) {
    const appid = rand() < 0.95 ? 10 * (1 + Math.floor(rand() * 350_000)) : 1 + Math.floor(rand() * 3_500_000);
    let name = '';
    const length = 8 + Math.floor(rand() * 57);
    while (name.length < length) name += `${words[Math.floor(rand() * words.length)]} `;
    const total = Math.floor(rand() * 200);
    const unlocked = Math.floor(rand() * (total + 1));
    library.set(appid, {
      n: name.trim().slice(0, length), i: Array.from({ length: 40 }, () => Math.floor(rand() * 16).toString(16)).join(''),
      p: Math.floor(rand() * 200_000), w: Math.floor(rand() * 2000), r: 1_300_000_000 + Math.floor(rand() * 500_000_000),
      f: Math.floor(rand() * 256), ap: total ? Math.round(unlocked / total * 10000) / 100 : 0, au: unlocked, at: total,
    });
  }
  return library;
}

describe.skipIf(!emulated)('library index (emulator)', () => {
  it('stores a synthetic 8,000-game library within document and index-entry limits, loading it in four reads', async () => {
    const steamId = freshUser();
    const library = syntheticLibrary(8000);
    expect((await patchLibIndex(steamId, library, { create: true })).applied).toHaveLength(8000);

    const report: string[] = [];
    let games = 0;
    for (let chunk = 0; chunk < 4; chunk++) {
      const path = paths.libIndexChunk(steamId, chunk);
      const data = (await db.doc(path).get()).data()!;
      const count = Object.keys(data.games).length;
      const bytes = documentSize(path, data);
      const exempt = estimateIndexEntries(data, ['games']);
      const unexempt = estimateIndexEntries(data);
      // Games a chunk could hold before reaching 1 MiB, and before reaching 40,000 index entries without the exemption.
      const bySize = Math.floor(MAX_DOCUMENT_BYTES / (bytes / count));
      const byUnexemptIndex = Math.floor(MAX_INDEX_ENTRIES / (unexempt / count));
      report.push(`chunk ${chunk}: ${count} games, ${bytes} bytes (${(bytes / MAX_DOCUMENT_BYTES * 100).toFixed(1)}% of 1 MiB), ` +
        `${exempt} index entries with the exemption, ${unexempt} without; ceiling ${bySize} games by size, ${byUnexemptIndex} unexempt`);
      games += count;
      expect(count / library.size).toBeGreaterThan(0.23);
      expect(count / library.size).toBeLessThan(0.27);
      expect(bytes).toBeLessThan(MAX_DOCUMENT_BYTES);
      expect(exempt).toBeLessThanOrEqual(MAX_INDEX_ENTRIES);
      // Without the exemption the index-entry limit, not the size limit, would cap the library.
      expect(byUnexemptIndex).toBeLessThan(bySize / 2);
    }
    console.info(report.join('\n'));
    expect(games).toBe(8000);

    const reads = countReads();
    const index = await readLibIndex(steamId);
    expect(reads()).toBeLessThanOrEqual(4);
    expect(index.built).toBe(true);
    expect(index.updatedAt).toBeInstanceOf(Date);
    expect(index.entries.size).toBe(8000);
    for (const [appid, patch] of library) expect(index.entries.get(appid)).toEqual(patch);
  }, 60_000);

  it('keeps every field when separate writers patch the same entries concurrently', async () => {
    const steamId = freshUser();
    const appids = Array.from({ length: 200 }, (_, index) => 10 * (index + 1) + (index % 4));
    await patchLibIndex(steamId, new Map(appids.map(appid => [appid, { n: `Game ${appid}`, p: 1 }])), { create: true });

    // Library sync (base fields, upsert), app metadata (flags) and achievements (summary) all at once, twice over.
    await Promise.all([1, 2].flatMap(round => [
      patchLibIndex(steamId, new Map(appids.map(appid => [appid, { n: `Game ${appid}`, p: 100 * round, w: round, r: 1_700_000_000 }])), { create: true }),
      patchLibIndex(steamId, new Map(appids.map(appid => [appid, { f: 3 }]))),
      patchLibIndex(steamId, new Map(appids.map(appid => [appid, { ap: 50, au: round, at: 4 }]))),
    ]));

    const { entries } = await readLibIndex(steamId);
    expect(entries.size).toBe(200);
    for (const appid of appids) {
      expect(Object.keys(entries.get(appid)!).sort()).toEqual(['ap', 'at', 'au', 'f', 'n', 'p', 'r', 'w']);
      expect(entries.get(appid)).toMatchObject({ n: `Game ${appid}`, f: 3, ap: 50, at: 4, r: 1_700_000_000 });
    }
  }, 60_000);

  it('removes entries and fields without resurrecting removed games', async () => {
    const steamId = freshUser();
    await patchLibIndex(steamId, { 620: { n: 'Portal 2', p: 10, ap: 40 }, 400: { n: 'Portal', p: 5 }, 621: { n: 'Other' } }, { create: true });

    expect(await removeFromLibIndex(steamId, [400, 999])).toEqual([400]);
    expect(await patchLibIndex(steamId, { 400: { f: 1 }, 620: { ap: null, f: 2 } })).toEqual({ applied: [620], skipped: [400] });

    const { entries } = await readLibIndex(steamId);
    expect([...entries.keys()].sort()).toEqual([620, 621]);
    expect(entries.get(620)).toEqual({ n: 'Portal 2', p: 10, f: 2 });
    expect((await db.doc(paths.libIndexChunk(steamId, libIndexChunkOf(400))).get()).data()?.games).not.toHaveProperty('400');
  });

  it('reports an index that was never built, and leaves it unbuilt after no-op writes', async () => {
    const steamId = freshUser();
    expect(await removeFromLibIndex(steamId, [620])).toEqual([]);
    expect(await patchLibIndex(steamId, { 620: { f: 1 } })).toEqual({ applied: [], skipped: [620] });
    const reads = countReads();
    expect(await readLibIndex(steamId)).toEqual({ entries: new Map(), built: false, updatedAt: null });
    expect(reads()).toBe(4);
  });
});
