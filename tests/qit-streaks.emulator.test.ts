import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { db } from '../src/lib/firestore';
import { recordEvent } from '../src/lib/history/events';
import { markPlayed, recordRoll } from '../src/lib/history/rolls';
import { readStats } from '../src/lib/history/stats';
import { setProfileTimeZone } from '../src/lib/profile/timezone';
import { paths } from '../src/lib/store/paths';

let serial = 0;
const freshUser = () => `76561198${String(Date.now() % 1e7).padStart(7, '0')}${String(serial++).padStart(2, '0')}`;
const ms = Date.parse;
const play = (user: string, id: string, at: string) => recordEvent(user, { type: 'played', appid: 620, meta: { playtimeAtRoll: 0 } }, ms(at), id);
const progress = async (user: string, at: string) => (await readStats(user, ms(at))).progression;

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('streaks (emulator)', () => {
  it('counts consecutive days once, ages to zero, and retains the longest after a missed day', async () => {
    const user = freshUser();
    await play(user, 'one', '2026-01-01T12:00Z');
    await play(user, 'two', '2026-01-02T12:00Z');
    await play(user, 'same-day', '2026-01-02T15:00Z');
    expect(await progress(user, '2026-01-02T16:00Z')).toMatchObject({ current: 2, longest: 2, gamesDiscovered: 1, backlogGamesStarted: 1 });
    expect(await progress(user, '2026-01-03T23:59Z')).toMatchObject({ current: 2, longest: 2 });
    expect(await progress(user, '2026-01-04T00:00Z')).toMatchObject({ current: 0, longest: 2 });
    await play(user, 'four', '2026-01-04T12:00Z');
    expect(await progress(user, '2026-01-04T13:00Z')).toMatchObject({ current: 1, longest: 2 });
    expect((await db.doc(paths.statsSummary(user)).get()).get('streak')).toMatchObject({ current: 1, longest: 2 });
  });

  it('is idempotent under concurrent event replays and repeated reads', async () => {
    const user = freshUser();
    await Promise.all(Array.from({ length: 5 }, () => recordEvent(user, { type: 'challenge_complete', appid: 10, refId: 'challenge1', meta: { kind: 'rare' } }, ms('2026-01-01T12:00Z'), 'stable')));
    const first = await readStats(user, ms('2026-01-01T13:00Z'));
    expect(first.counters).toEqual({ challenge_complete: 1, 'challenge_complete:kind:rare': 1 });
    expect(first.progression).toMatchObject({ current: 1, challengesCompleted: 1, rareAchievementsCompleted: 1 });
    expect(await readStats(user, ms('2026-01-01T13:00Z'))).toEqual(first);
    expect((await db.collection(paths.events(user)).get()).size).toBe(1);
  });

  it.each([
    ['spring forward', ['2026-03-07T20:00Z', '2026-03-08T19:00Z', '2026-03-09T19:00Z']],
    ['fall back', ['2026-10-31T19:00Z', '2026-11-01T20:00Z', '2026-11-02T20:00Z']],
  ])('uses calendar days across %s', async (_name, dates) => {
    const user = freshUser();
    await db.doc(paths.user(user)).set({ tz: 'America/Los_Angeles' });
    for (const [i, at] of dates.entries()) await play(user, String(i), at);
    expect(await progress(user, dates[2])).toMatchObject({ current: 3, longest: 3 });
  });

  it('deduplicates the repeated DST hour and respects local midnight', async () => {
    const user = freshUser();
    await db.doc(paths.user(user)).set({ tz: 'America/Los_Angeles' });
    await play(user, 'a', '2026-11-01T08:30Z');
    await play(user, 'b', '2026-11-01T09:30Z');
    await play(user, 'c', '2026-11-02T07:59Z');
    expect(await progress(user, '2026-11-02T07:59Z')).toMatchObject({ current: 1, longest: 1 });
    await play(user, 'd', '2026-11-02T08:00Z');
    expect(await progress(user, '2026-11-02T08:00Z')).toMatchObject({ current: 2, longest: 2 });
  });

  it('captures a timezone once and reprojects history after an explicit timezone change', async () => {
    const user = freshUser();
    await db.doc(paths.user(user)).set({ personaName: 'Player' });
    expect(await setProfileTimeZone(user, 'UTC', true)).toBe('UTC');
    expect(await setProfileTimeZone(user, 'Asia/Tokyo', true)).toBe('UTC');
    await play(user, 'a', '2026-01-01T23:30Z');
    await play(user, 'b', '2026-01-02T00:30Z');
    expect(await progress(user, '2026-01-02T01:00Z')).toMatchObject({ current: 2, longest: 2 });
    await setProfileTimeZone(user, 'America/Los_Angeles');
    expect(await progress(user, '2026-01-02T01:00Z')).toMatchObject({ current: 1, longest: 1, lastDay: '2026-01-01', gamesDiscovered: 1 });
    await expect(setProfileTimeZone(user, 'Not/AZone')).rejects.toThrow('Invalid IANA timezone');
    expect((await db.doc(paths.user(user)).get()).get('personaName')).toBe('Player');
  });

  it('credits played detection, backfills old played events, and never credits acceptance', async () => {
    const user = freshUser();
    const now = ms('2026-01-01T12:00Z');
    const roll = await recordRoll(user, { appid: 620, modeId: 'pure-random', filters: [], scope: { kind: 'library' }, playtimeAtRoll: 0, reasons: [] }, now);
    await recordEvent(user, { type: 'accept', refId: roll }, now);
    expect(await progress(user, '2026-01-01T12:00Z')).toMatchObject({ current: 0, gamesDiscovered: 0 });
    await markPlayed(user, roll, 'sync', now);
    await markPlayed(user, roll, 'manual', now);
    expect(await progress(user, '2026-01-01T12:00Z')).toMatchObject({ current: 1, backlogGamesStarted: 1 });
    // Historic format without playtime metadata, as emitted before this package.
    await db.doc(paths.roll(user, 'old-roll')).set({ playtimeAtRoll: 0 });
    await recordEvent(user, { type: 'played', appid: 10, refId: 'old-roll' }, now);
    expect(await progress(user, '2026-01-01T12:00Z')).toMatchObject({ gamesDiscovered: 2, backlogGamesStarted: 2 });
  });

  it('invalidates a cached projection for a backdated event and for future events becoming due', async () => {
    const user = freshUser();
    await play(user, 'one', '2026-01-01T12:00Z');
    await play(user, 'three', '2026-01-03T12:00Z');
    expect(await progress(user, '2026-01-03T13:00Z')).toMatchObject({ current: 1, longest: 1 });
    await play(user, 'two', '2026-01-02T12:00Z');
    expect(await progress(user, '2026-01-03T13:00Z')).toMatchObject({ current: 3, longest: 3 });
    await recordEvent(user, { type: 'challenge_complete' }, ms('2026-01-03T16:00Z'));
    expect((await progress(user, '2026-01-03T14:00Z')).challengesCompleted).toBe(0);
    expect((await progress(user, '2026-01-03T16:00Z')).challengesCompleted).toBe(1);
    expect((await db.doc(paths.statsSummary(user)).get()).get('updatedAt')).toBeInstanceOf(Timestamp);
    expect(await progress(user, '2025-12-31T12:00Z')).toMatchObject({ current: 0, longest: 0, lastDay: null });
    expect((await db.doc(paths.statsSummary(user)).get()).get('streak')).toEqual({ current: 0, longest: 0 });
  });
});
