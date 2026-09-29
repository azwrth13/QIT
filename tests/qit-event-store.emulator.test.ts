import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { db } from '../src/lib/firestore';
import { recordEvent } from '../src/lib/history/events';
import { ExclusionLimitError, MAX_EXCLUSIONS, addExclusion, readExclusions, removeExclusion } from '../src/lib/history/exclusions';
import {
  getRoll, listRolls, markAccepted, markPlayed, markRerolled, recentlyRolled, recordRoll, type RollInput,
} from '../src/lib/history/rolls';
import { readStats } from '../src/lib/history/stats';
import { paths } from '../src/lib/store/paths';

// Emulator-only (npm run test:firestore). Skipped elsewhere so it can never touch a real project.
const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;

let nextId = 0;
const freshUser = () => `7656119901${String(Date.now() % 1e5).padStart(5, '0')}${String(nextId++ % 100).padStart(2, '0')}`;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-28T10:00:00Z');

const listEvents = async (steamId: string) =>
  (await db.collection(paths.events(steamId)).orderBy('at', 'desc').get()).docs.map(doc => doc.data());

const input = (overrides: Partial<RollInput> = {}): RollInput => ({
  appid: 620, name: 'Portal 2', modeId: 'dust-collector', filters: [{ id: 'never-played' }], scope: { kind: 'library' },
  playtimeAtRoll: 0, reasons: [{ code: 'never_launched', params: {} }], ...overrides,
});

describe.skipIf(!emulated)('rolls (emulator)', () => {
  it('records a roll with its event and counters', async () => {
    const steamId = freshUser();
    const rollId = await recordRoll(steamId, input(), NOW);
    const roll = await getRoll(steamId, rollId);
    expect(roll).toMatchObject({
      id: rollId, appid: 620, name: 'Portal 2', modeId: 'dust-collector', status: 'rolled', participants: [steamId],
      scope: { kind: 'library' }, filters: [{ id: 'never-played' }], playtimeAtRoll: 0, acceptedAt: null, playedAt: null,
    });
    expect(roll!.at.getTime()).toBe(NOW);
    const events = await listEvents(steamId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'roll', appid: 620, refId: rollId, meta: { modeId: 'dust-collector', scope: 'library' } });
    expect((await readStats(steamId)).counters).toEqual({ roll: 1, 'roll:modeId:dust-collector': 1 });
  });

  it('moves through the status lifecycle, counting each change once', async () => {
    const steamId = freshUser();
    const a = await recordRoll(steamId, input({ appid: 10 }), NOW);
    const b = await recordRoll(steamId, input({ appid: 20, modeId: 'rediscovery' }), NOW + 1);

    const accepted = await markAccepted(steamId, a, NOW + 10);
    expect(accepted.outcome).toBe('updated');
    expect(accepted.outcome !== 'not_found' && accepted.roll.acceptedAt?.getTime()).toBe(NOW + 10);
    expect((await markAccepted(steamId, a, NOW + 20)).outcome).toBe('unchanged');
    expect((await markRerolled(steamId, a, NOW + 30)).outcome).toBe('conflict');

    expect((await markRerolled(steamId, b, NOW + 40)).outcome).toBe('updated');
    expect((await markRerolled(steamId, b, NOW + 50)).outcome).toBe('unchanged');
    expect((await markAccepted(steamId, b, NOW + 60)).outcome).toBe('conflict');

    // Played is independent of the decision, and the first source wins.
    expect((await markPlayed(steamId, b, 'sync', NOW + 70)).outcome).toBe('updated');
    const again = await markPlayed(steamId, b, 'manual', NOW + 80);
    expect(again.outcome).toBe('unchanged');
    expect(again.outcome !== 'not_found' && again.roll.playedSource).toBe('sync');

    expect((await markAccepted(steamId, 'missing', NOW)).outcome).toBe('not_found');
    expect(await getRoll(steamId, 'missing')).toBeNull();

    expect(await getRoll(steamId, a)).toMatchObject({ status: 'accepted', rerolledAt: null, playedAt: null });
    const stored = await getRoll(steamId, b);
    expect(stored).toMatchObject({ status: 'rerolled', acceptedAt: null, playedSource: 'sync' });
    expect(stored!.playedAt!.getTime()).toBe(NOW + 70);

    expect((await readStats(steamId)).counters).toEqual({
      roll: 2, 'roll:modeId:dust-collector': 1, 'roll:modeId:rediscovery': 1,
      accept: 1, 'accept:modeId:dust-collector': 1, reroll: 1, played: 1, 'played:source:sync': 1,
    });
    expect((await listEvents(steamId)).map(event => event.type)).toEqual(['played', 'reroll', 'accept', 'roll', 'roll']);
  });

  it('keeps counters exact under concurrent writes', async () => {
    const steamId = freshUser();
    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => recordRoll(steamId, input({ appid: 10 * (i + 1) }), NOW + i)));
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => markAccepted(steamId, ids[0], NOW + 100)));
    expect(outcomes.filter(result => result.outcome === 'updated')).toHaveLength(1);
    const stats = await readStats(steamId);
    expect(stats.counters.roll).toBe(10);
    expect(stats.counters.accept).toBe(1);
    expect(stats.updatedAt).toBeInstanceOf(Date);
  });

  it('reports recently rolled games within the anti-repeat window', async () => {
    const steamId = freshUser();
    await recordRoll(steamId, input({ appid: 10 }), NOW - 40 * DAY);
    await recordRoll(steamId, input({ appid: 20 }), NOW - 10 * DAY);
    await recordRoll(steamId, input({ appid: 20 }), NOW - DAY);
    await recordRoll(steamId, input({ appid: 30 }), NOW - 2 * DAY);
    const recent = await recentlyRolled(steamId, { days: 30, now: NOW });
    expect(Object.fromEntries(recent)).toEqual({
      20: { count: 2, lastRolledAt: (NOW - DAY) / 1000 },
      30: { count: 1, lastRolledAt: (NOW - 2 * DAY) / 1000 },
    });
    expect([...(await recentlyRolled(steamId, { days: 90, now: NOW })).keys()].sort((a, b) => a - b)).toEqual([10, 20, 30]);
    expect((await recentlyRolled(steamId, { days: 0, now: NOW })).size).toBe(0);
  });

  it('pages newest first without skipping or repeating rolls that share a timestamp', async () => {
    const steamId = freshUser();
    const times = [NOW, NOW, NOW, NOW + 5, NOW - 5, NOW, NOW + 5];
    const ids = [];
    for (const [i, at] of times.entries()) ids.push(await recordRoll(steamId, input({ appid: 10 * (i + 1) }), at));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listRolls(steamId, { limit: 2, cursor });
      seen.push(...page.rolls.map(roll => roll.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(times.length);
    expect(new Set(seen)).toEqual(new Set(ids));
    const order = await Promise.all(seen.map(id => getRoll(steamId, id)));
    const stamps = order.map(roll => roll!.at.getTime());
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    expect((await listRolls(freshUser())).rolls).toEqual([]);
  });
});

describe.skipIf(!emulated)('exclusions (emulator)', () => {
  it('stores each scope and reads back only the active ones', async () => {
    const steamId = freshUser();
    const day = await addExclusion(steamId, 10, 'day', { tz: 'Europe/Madrid', now: NOW });
    expect(day.until?.toISOString()).toBe('2026-09-28T22:00:00.000Z');
    await addExclusion(steamId, 20, '7d', { now: NOW });
    await addExclusion(steamId, 30, 'forever', { now: NOW });
    await addExclusion(steamId, 40, 'session', { sessionId: 'picker-1', now: NOW });

    expect([...(await readExclusions(steamId, { now: NOW })).keys()].sort((a, b) => a - b)).toEqual([10, 20, 30]);
    expect([...(await readExclusions(steamId, { sessionId: 'picker-1', now: NOW })).keys()].sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
    expect((await readExclusions(steamId, { sessionId: 'other', now: NOW })).has(40)).toBe(false);
    // Tomorrow: "Not tonight" has lapsed; a week later only the permanent hide remains.
    expect([...(await readExclusions(steamId, { now: NOW + DAY })).keys()].sort((a, b) => a - b)).toEqual([20, 30]);
    expect([...(await readExclusions(steamId, { now: NOW + 8 * DAY })).keys()]).toEqual([30]);

    expect((await readStats(steamId)).counters).toMatchObject({ exclude: 4, 'exclude:scope:day': 1, 'exclude:scope:forever': 1 });
  });

  it('replaces an exclusion with the latest choice, except a permanent hide', async () => {
    const steamId = freshUser();
    await addExclusion(steamId, 10, 'session', { sessionId: 's1', now: NOW });
    const replaced = await addExclusion(steamId, 10, '7d', { now: NOW + 1 });
    expect(replaced).toMatchObject({ scope: '7d', sessionId: null });
    const stored = (await db.doc(paths.exclusions(steamId)).get()).data()!;
    expect(stored['10']).not.toHaveProperty('sessionId');

    await addExclusion(steamId, 20, 'forever', { now: NOW });
    const kept = await addExclusion(steamId, 20, 'day', { now: NOW + 1 });
    expect(kept).toMatchObject({ scope: 'forever', until: null });
    expect((await readStats(steamId)).counters.exclude).toBe(3);
  });

  it('prunes expired entries on write and un-hides games', async () => {
    const steamId = freshUser();
    await addExclusion(steamId, 10, 'day', { now: NOW });
    await addExclusion(steamId, 20, 'forever', { now: NOW });
    await addExclusion(steamId, 30, '7d', { now: NOW + 2 * DAY });
    expect(Object.keys((await db.doc(paths.exclusions(steamId)).get()).data()!).sort()).toEqual(['20', '30']);

    expect(await removeExclusion(steamId, 20, NOW + 2 * DAY)).toBe(true);
    expect(await removeExclusion(steamId, 20, NOW + 2 * DAY)).toBe(false);
    expect(await removeExclusion(steamId, 99, NOW + 2 * DAY)).toBe(false);
    expect([...(await readExclusions(steamId, { now: NOW + 2 * DAY })).keys()]).toEqual([30]);
    expect((await readStats(steamId)).counters.unexclude).toBe(1);
  });

  it(`caps active exclusions at ${MAX_EXCLUSIONS}`, async () => {
    const steamId = freshUser();
    const at = Timestamp.fromMillis(NOW);
    await db.doc(paths.exclusions(steamId)).set(Object.fromEntries(Array.from({ length: MAX_EXCLUSIONS }, (_, i) => [String(10 * (i + 1)), { scope: 'forever', at }])));
    await expect(addExclusion(steamId, 7, '7d', { now: NOW })).rejects.toBeInstanceOf(ExclusionLimitError);
    // Changing a game already in the list is still allowed at the cap.
    await removeExclusion(steamId, 10, NOW);
    await addExclusion(steamId, 7, '7d', { now: NOW });
    expect((await readExclusions(steamId, { now: NOW })).size).toBe(MAX_EXCLUSIONS);
    await expect(addExclusion(steamId, 7, 'day', { now: NOW })).resolves.toMatchObject({ scope: 'day' });
  });
});

describe.skipIf(!emulated)('events and stats (emulator)', () => {
  it('lets other packages record their own event types', async () => {
    const steamId = freshUser();
    await recordEvent(steamId, { type: 'challenge_complete', appid: 620, refId: 'c1', meta: { tier: 5 } }, NOW);
    await recordEvent(steamId, { type: 'challenge_complete', appid: 400 }, NOW + 1);
    await recordEvent(steamId, { type: 'daily_accept', appid: 620 }, NOW + 2);
    expect((await readStats(steamId)).counters).toEqual({ challenge_complete: 2, daily_accept: 1 });
    const events = await listEvents(steamId);
    expect(events.map(event => event.type)).toEqual(['daily_accept', 'challenge_complete', 'challenge_complete']);
    expect(events[2]).toMatchObject({ appid: 620, refId: 'c1', meta: { tier: 5 } });
    await expect(recordEvent(steamId, { type: 'Bad Type' })).rejects.toThrow('Invalid event type');
  });

  it('returns empty stats for a user with no events', async () => {
    expect(await readStats(freshUser())).toEqual({ counters: {}, streak: null, updatedAt: null });
  });
});
