import { readFileSync } from 'node:fs';
import { FieldValue, Timestamp, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { paths } from '../src/lib/store/paths';
import { isExpired, libIndexChunkConverter, stripUndefined, toLibIndexEntry, toTimestamp } from '../src/lib/store/converters';
import { LIB_INDEX_CHUNKS, libIndexChunkOf, planLibIndexPatch } from '../src/lib/store/lib-index';
import { MAX_INDEX_ENTRIES, documentNameSize, documentSize, estimateIndexEntries } from '../src/lib/store/limits';

const steamId = '76561198000000042';

describe('paths', () => {
  it('builds every path from validated ids', () => {
    expect(paths.libIndexChunk(steamId, 3)).toBe(`users/${steamId}/libIndex/3`);
    expect(paths.userGame(steamId, 620)).toBe(`users/${steamId}/games/620`);
    expect(paths.daily(steamId, '2026-09-29')).toBe(`users/${steamId}/daily/2026-09-29`);
    expect(paths.exclusions(steamId)).toBe(`users/${steamId}/prefs/exclusions`);
    expect(paths.appMeta(620)).toBe('appMeta/620');
    expect(paths.lobbyCommonChunk('K7QX2M', 0)).toBe('lobbies/K7QX2M/common/0');
  });

  it('rejects ids that could escape or corrupt a path', () => {
    expect(() => paths.user('../users/x')).toThrow('Invalid Steam ID');
    expect(() => paths.appMeta(0)).toThrow('Invalid app ID');
    expect(() => paths.appMeta(1.5)).toThrow('Invalid app ID');
    expect(() => paths.appMeta(Number.MAX_SAFE_INTEGER + 2)).toThrow('Invalid app ID');
    expect(() => paths.roll(steamId, 'a/b')).toThrow('Invalid document ID');
    expect(() => paths.lobby('..')).toThrow('Invalid document ID');
    expect(() => paths.daily(steamId, '2026-13-01')).toThrow('Invalid date key');
    expect(() => paths.libIndexChunk(steamId, -1)).toThrow('Invalid chunk');
  });
});

describe('library index planning', () => {
  it('spreads realistic appids evenly over the four chunks', () => {
    expect(LIB_INDEX_CHUNKS).toBe(4);
    expect(libIndexChunkOf('620')).toBe(libIndexChunkOf(620));
    expect(() => libIndexChunkOf(0)).toThrow('Invalid app ID');
    // Steam appids are almost all multiples of 10; check that stride and coarser ones.
    for (const step of [1, 10, 20, 40, 100]) {
      const counts = [0, 0, 0, 0];
      for (let appid = step; appid <= step * 40_000; appid += step) counts[libIndexChunkOf(appid)]++;
      for (const count of counts) expect(Math.abs(count / 40_000 - 0.25)).toBeLessThan(0.01);
    }
  });

  it('groups patches by chunk, maps null to a field delete, and drops empty patches', () => {
    const plan = planLibIndexPatch({ 620: { p: 10, ap: null }, 621: { w: undefined }, 570: { n: 'Other' } }, false);
    expect([...plan.keys()].sort()).toEqual([libIndexChunkOf(620), libIndexChunkOf(570)].sort());
    expect(plan.get(libIndexChunkOf(620))!.get(620)).toEqual({ p: 10, ap: FieldValue.delete() });
    expect(plan.get(libIndexChunkOf(570))!.get(570)).toEqual({ n: 'Other' });
    expect([...plan.values()].some(entries => entries.has(621))).toBe(false);
  });

  it('rejects unknown fields, bad values, and creates without a name', () => {
    expect(() => planLibIndexPatch({ 620: { x: 1 } as never }, false)).toThrow('Unknown library index field x');
    expect(() => planLibIndexPatch({ 620: { p: Number.NaN } }, false)).toThrow('Invalid value');
    expect(() => planLibIndexPatch({ 620: { n: null } as never }, false)).toThrow('Invalid value');
    expect(() => planLibIndexPatch({ 620: { i: 5 } as never }, false)).toThrow('Invalid value');
    expect(() => planLibIndexPatch({ 620: { p: 1 } }, true)).toThrow('requires a name');
    expect(() => planLibIndexPatch({ abc: { p: 1 } }, false)).toThrow('Invalid app ID');
  });
});

describe('converters', () => {
  it('sanitizes index entries on read, treating malformed fields as unknown', () => {
    expect(toLibIndexEntry({ n: 'Portal', p: 5, w: 'x', ap: Number.POSITIVE_INFINITY, i: 'abc', z: 1 })).toEqual({ n: 'Portal', p: 5, i: 'abc' });
    expect(toLibIndexEntry({ p: 5 })).toBeNull();
    const updatedAt = Timestamp.fromMillis(1000);
    const snapshot = { data: () => ({ games: { 620: { n: 'Portal 2' }, bad: { n: 'x' }, 400: { p: 1 } }, updatedAt }) };
    expect(libIndexChunkConverter.fromFirestore(snapshot as unknown as QueryDocumentSnapshot))
      .toEqual({ games: { 620: { n: 'Portal 2' } }, updatedAt });
  });

  it('strips undefined from plain objects only and handles time fields', () => {
    const now = Timestamp.fromMillis(5);
    expect(stripUndefined({ a: 1, b: undefined, c: { d: undefined, e: [{ f: undefined }] }, now })).toEqual({ a: 1, c: { e: [{}] }, now });
    expect(toTimestamp('1970-01-01T00:00:01.000Z').toMillis()).toBe(1000);
    expect(() => toTimestamp('nope')).toThrow('Invalid time');
    expect(isExpired(Timestamp.fromMillis(2000), 1000)).toBe(false);
    expect(isExpired(Timestamp.fromMillis(1000), 1000)).toBe(true);
    expect(isExpired('2099-01-01T00:00:00Z', 1000)).toBe(true);
  });
});

describe('limits', () => {
  it('follows the documented storage size rules', () => {
    // Firestore's worked example: users/jeff/tasks/my_task_id is 6 + 5 + 6 + 11 + 16 = 44 bytes.
    expect(documentNameSize('users/jeff/tasks/my_task_id')).toBe(44);
    // The example document `{type: 'Personal', done: false, priority: 1, description: 'Learn Cloud Firestore'}` is 147 bytes.
    expect(documentSize('users/jeff/tasks/my_task_id', {
      type: 'Personal', done: false, priority: 1, description: 'Learn Cloud Firestore',
    })).toBe(147);
  });

  it('counts index entries and honors map exemptions', () => {
    const games = { 620: { n: 'Portal 2', p: 1 }, 400: { n: 'Portal' } };
    expect(estimateIndexEntries({ games, tags: ['a', 'a', 'b'] })).toBe((2 + 6 + 4) + (2 + 2));
    expect(estimateIndexEntries({ games, updatedAt: 1 }, ['games'])).toBe(2);
  });

  it('exempts the library index games map and declares no composite indexes', () => {
    const config = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8'));
    expect(config.indexes).toEqual([]);
    expect(config.fieldOverrides).toContainEqual({ collectionGroup: 'libIndex', fieldPath: 'games', ttl: false, indexes: [] });
    expect(MAX_INDEX_ENTRIES).toBe(40_000);
  });
});
