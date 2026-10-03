import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { STORE_FLAG_BITS } from '../src/lib/apps/metadata';
import { db } from '../src/lib/firestore';
import { getToday, actOnDaily, dailyHistory, saveDailySettings, DailyConflict } from '../src/lib/daily/service';
import { drawDaily } from '../src/lib/daily/selection';
import { addExclusion } from '../src/lib/history/exclusions';
import { readStats } from '../src/lib/history/stats';
import { recordRoll } from '../src/lib/history/rolls';
import { getMode } from '../src/lib/roulette/modes';
import { orderReasons } from '../src/lib/roulette/reasons';
import { DEFAULT_DEPS } from '../src/lib/roulette/service';
import type { PipelineDeps } from '../src/lib/roulette/pipeline';
import { patchLibIndex } from '../src/lib/store/lib-index';
import { paths } from '../src/lib/store/paths';
import { localDate } from '../src/lib/history/time';

const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;
const now = Date.parse('2026-10-03T18:00:00Z');
const day = 86_400_000;
let serial = 0;
const freshUser = () => `7656119913${String(Date.now() % 1e5).padStart(5, '0')}${String(serial++ % 100).padStart(2, '0')}`;
// Exercise real library, history, filter and scoring services. All store flags are cached; header/live Steam calls are disabled.
const deps: PipelineDeps = { ...DEFAULT_DEPS, now: () => now, headerArt: async () => null,
  loaders: { ...DEFAULT_DEPS.loaders, store: async () => {}, live: async () => {} } };
async function user({ mode = 'pure-random', antiRepeatDays = 30, count = 6, tz = 'America/Los_Angeles' } = {}) {
  const id = freshUser();
  await db.doc(paths.user(id)).set({ tz, dailySettings: { mode, antiRepeatDays } });
  const games = Object.fromEntries(Array.from({ length: count }, (_, i) => [10000 + i * 10, { n: `Game ${i}`, p: i === 0 ? 0 : i * 50,
    r: i === 0 ? 0 : Math.floor((now - 500 * day) / 1000), w: 0, f: STORE_FLAG_BITS.known,
    at: 10, au: i === 0 ? 0 : 9, ap: i === 0 ? 0 : 90 }]));
  await patchLibIndex(id, games, { create: true });
  return id;
}
const events = async (id: string) => (await db.collection(paths.events(id)).get()).docs.map(doc => doc.data());

describe.skipIf(!emulated)('transactional Daily QIT against Firestore', { timeout: 30000 }, () => {
  it('commits exactly one snapshot/event on simultaneous first reads, and stays stable after library/preferences changes', async () => {
    const id = await user();
    const responses = await Promise.all(Array.from({ length: 5 }, () => getToday(id, now, deps)));
    expect(responses.every(response => JSON.stringify(response.today) === JSON.stringify(responses[0].today))).toBe(true);
    const initial = responses[0].today!;
    expect(initial.selection.card!.rollId).toBeNull();
    expect((await events(id)).filter(event => event.type === 'daily_roll')).toHaveLength(1);
    expect((await db.collection(paths.rolls(id)).get()).size).toBe(0);
    const stored = await db.doc(paths.daily(id, initial.date)).get();
    expect(stored.get('selection.selectedAt')).toBeInstanceOf(Timestamp);
    await patchLibIndex(id, { [initial.selection.card!.appid]: { n: 'Changed library name', p: 999 } });
    await saveDailySettings(id, { mode: 'dust-collector', antiRepeatDays: 0 });
    expect((await getToday(id, now + 1000, deps)).today).toEqual(initial);
    expect((await getToday(id, now + 1000, deps)).settings).toEqual({ mode: 'dust-collector', antiRepeatDays: 0 });
    expect((await getToday(id, now + day, deps)).today!.settings).toEqual({ mode: 'dust-collector', antiRepeatDays: 0 });
  });
  it('accept is idempotent and gives no streak credit; played emits one qualifying event even concurrently', async () => {
    const id = await user();
    const first = (await getToday(id, now, deps)).today!;
    await Promise.all(Array.from({ length: 3 }, () => actOnDaily(id, 'accept', first.date, 0, now + 100, deps)));
    let stats = await readStats(id, now + 200);
    expect(stats.counters.daily_accept).toBe(1); expect(stats.progression.current).toBe(0);
    await Promise.all(Array.from({ length: 3 }, () => actOnDaily(id, 'played', first.date, 0, now + 300, deps)));
    stats = await readStats(id, now + 400);
    expect(stats.counters.daily_played).toBe(1); expect(stats.progression.current).toBe(1); expect(stats.progression.gamesDiscovered).toBe(1);
    expect((await events(id)).find(event => event.type === 'daily_played')).toMatchObject({ appid: first.selection.card!.appid, meta: { source: 'manual' } });
    await expect(actOnDaily(id, 'reroll', first.date, 0, now + 500, deps)).rejects.toBeInstanceOf(DailyConflict);
    await expect(actOnDaily(id, 'skip', first.date, 0, now + 500, deps)).rejects.toBeInstanceOf(DailyConflict);
  });
  it('skip closes the day without streak credit and cannot be reopened or marked played', async () => {
    const id = await user();
    const first = (await getToday(id, now, deps)).today!;
    await actOnDaily(id, 'skip', first.date, 0, now + 100, deps);
    await actOnDaily(id, 'skip', first.date, 0, now + 100, deps);
    expect((await getToday(id, now + 200, deps)).today!.status).toBe('skipped');
    for (const action of ['played', 'accept', 'reroll'] as const) await expect(actOnDaily(id, action, first.date, 0, now + 300, deps)).rejects.toBeInstanceOf(DailyConflict);
    const stats = await readStats(id, now + 400);
    expect(stats.counters.daily_skip).toBe(1); expect(stats.progression.current).toBe(0);
  });
  it('allows only three non-repeating rerolls even with concurrent/stale requests and anti-repeat off', async () => {
    const id = await user({ antiRepeatDays: 0 });
    let daily = (await getToday(id, now, deps)).today!;
    const rerolls = await Promise.allSettled(Array.from({ length: 4 }, () => actOnDaily(id, 'reroll', daily.date, 0, now + 100, deps)));
    expect(rerolls.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    daily = (await getToday(id, now + 200, deps)).today!;
    for (let revision = 1; revision < 3; revision++) daily = (await actOnDaily(id, 'reroll', daily.date, revision, now + revision * 1000, deps)).today!;
    expect(daily.rerolls).toBe(3); expect(daily.previous).toHaveLength(3);
    expect(new Set([...daily.previous, daily.selection].map(selection => selection.card!.appid)).size).toBe(4);
    await expect(actOnDaily(id, 'reroll', daily.date, 3, now + 4000, deps)).rejects.toBeInstanceOf(DailyConflict);
    await expect(actOnDaily(id, 'played', daily.date, 0, now + 4000, deps)).rejects.toBeInstanceOf(DailyConflict);
    expect((await readStats(id, now + 5000)).counters).toMatchObject({ daily_roll: 4, daily_reroll: 3 });
  });
  it('honours permanent vetoes, roulette history and daily snapshots in the anti-repeat window', async () => {
    const id = await user({ count: 3 });
    await addExclusion(id, 10000, 'forever', { now });
    await recordRoll(id, { appid: 10010, modeId: 'pure-random', filters: [], scope: { kind: 'library' }, playtimeAtRoll: 0, reasons: [] }, now - day);
    const first = (await getToday(id, now, deps)).today!;
    expect(first.selection.card!.appid).toBe(10020);
    const tomorrow = (await getToday(id, now + day, deps)).today!;
    expect(tomorrow.selection.card).toBeNull(); expect(tomorrow.status).toBe('empty');
    const rerolled = (await actOnDaily(id, 'reroll', tomorrow.date, 0, now + day + 100, deps)).today!;
    expect(rerolled.selection.card).toBeNull(); expect(rerolled.rerolls).toBe(1);
    // The game becomes eligible again after the configured window expires.
    expect((await getToday(id, now + 31 * day, deps)).today!.selection.card).not.toBeNull();
  });
  it('uses stored local days across midnight and DST, and refuses actions aimed at yesterday', async () => {
    const id = await user();
    const before = Date.parse('2026-11-01T07:30:00Z'); // 00:30, before the fall-back transition
    const first = await getToday(id, before, deps);
    expect(first.today!.date).toBe('2026-11-01');
    expect(first.nextDayAt).toBe(Date.parse('2026-11-02T08:00:00Z'));
    expect((await getToday(id, Date.parse('2026-11-01T09:30:00Z'), deps)).today).toEqual(first.today);
    await expect(actOnDaily(id, 'accept', first.today!.date, 0, first.nextDayAt, deps)).rejects.toBeInstanceOf(DailyConflict);
    expect((await getToday(id, first.nextDayAt, deps)).today!.date).toBe('2026-11-02');
    const east = await user({ tz: 'Pacific/Auckland' });
    expect((await getToday(east, now, deps)).today!.date).toBe(localDate(now, 'Pacific/Auckland'));
  });
  it('stores empty libraries once and does not silently select after a library change', async () => {
    const id = await user({ count: 0 });
    const empty = (await getToday(id, now, deps)).today!;
    expect(empty).toMatchObject({ status: 'empty', rerolls: 0, selection: { card: null } });
    expect((await events(id))).toHaveLength(0);
    await patchLibIndex(id, { 12345: { n: 'New game', p: 0, f: STORE_FLAG_BITS.known } }, { create: true });
    expect((await getToday(id, now + 100, deps)).today).toEqual(empty);
    const retried = (await actOnDaily(id, 'reroll', empty.date, 0, now + 200, deps)).today!;
    expect(retried.selection.card!.appid).toBe(12345); expect(retried.rerolls).toBe(1);
  });
  it('backlog mix is deterministic, emits reasons from the chosen mode, and tolerates missing achievements', async () => {
    const id = await user({ mode: 'backlog-mix', antiRepeatDays: 0 });
    const first = await drawDaily(id, '2026-10-03', 0, { mode: 'backlog-mix', antiRepeatDays: 0 }, [], now, deps);
    const again = await drawDaily(id, '2026-10-03', 0, { mode: 'backlog-mix', antiRepeatDays: 0 }, [], now, deps);
    expect(first).toEqual(again); expect(first.card!.reasons.length).toBeGreaterThan(0);
    expect(['dust-collector', 'rediscovery', 'finish-something', 'something-different']).toContain(first.card!.modeId);
    for (let index = 0; index < 8; index++) {
      const card = (await drawDaily(id, '2026-10-03', index, { mode: 'backlog-mix', antiRepeatDays: 0 }, [], now, deps)).card!;
      expect(card.reasons).toEqual(orderReasons(card.reasons, getMode(card.modeId).emits));
    }
    const partial = await user({ mode: 'backlog-mix', count: 0 });
    await patchLibIndex(partial, { 10000: { n: 'Partial', p: 0, f: STORE_FLAG_BITS.known } }, { create: true });
    expect((await getToday(partial, now, deps)).today!.selection.card).not.toBeNull();
  });
  it('history is bounded, paginated, isolated by user, and includes stable earlier rerolls', async () => {
    const id = await user({ antiRepeatDays: 0, count: 30 });
    for (let i = 0; i < 23; i++) await getToday(id, now + i * day, deps);
    const first = await dailyHistory(id);
    expect(first.dailies).toHaveLength(20); expect(first.nextCursor).not.toBeNull();
    const older = await dailyHistory(id, first.nextCursor!);
    expect(older.dailies).toHaveLength(3); expect(older.nextCursor).toBeNull();
    expect(new Set([...first.dailies, ...older.dailies].map(daily => daily.date)).size).toBe(23);
    const other = await user(); expect((await dailyHistory(other)).dailies).toEqual([]);
  });
  it('settings reject group-only, unknown modes and unsupported windows', async () => {
    const id = await user();
    for (const settings of [{ mode: 'everyone-owns-it', antiRepeatDays: 30 }, { mode: 'unknown', antiRepeatDays: 30 }, { mode: 'pure-random', antiRepeatDays: 14 }]) {
      await expect(saveDailySettings(id, settings)).rejects.toThrow('Choose an available');
    }
  });
});
