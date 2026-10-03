import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/firestore';
import { paths } from '../src/lib/store/paths';
import { addExclusion, endExclusionSession, listExclusions, readExclusions, removeExclusion } from '../src/lib/history/exclusions';
import { applyExclusions } from '../src/lib/roulette/exclusions';
import { candidateFromIndexEntry } from '../src/lib/roulette/scopes/library';
import { GET, POST } from '../src/app/api/user/exclusions/route';

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getSteamId: auth }));
const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;
let serial = 0;
const freshUser = () => '7656119934' + String(Date.now() % 100000).padStart(5, '0') + String(serial++ % 100).padStart(2, '0');
const now = Date.parse('2026-03-08T08:30:00Z'); // 00:30 before the LA spring-forward day.
const dayEnd = Date.parse('2026-03-09T07:00:00Z');
const weekEnd = now + 7 * 86400000;
const request = (body: unknown, origin: string | null = 'https://qit.test') => new Request('https://qit.test/api/user/exclusions', {
  method: 'POST', headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe.skipIf(!emulated)('temporary veto API and exclusion stage (emulator)', () => {
  let user: string;
  beforeEach(async () => {
    user = freshUser();
    auth.mockResolvedValue(user);
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.test');
    await db.doc(paths.user(user)).set({ tz: 'America/Los_Angeles' });
    vi.spyOn(Date, 'now').mockReturnValue(now);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('uses the stored timezone at DST, expires exactly at local midnight and seven days, and retains permanent hides', async () => {
    for (const [appid, scope] of [[10, 'day'], [20, '7d'], [30, 'forever'], [40, 'session']] as const) {
      expect((await POST(request({ action: 'hide', appid, scope, tz: 'UTC', ...(scope === 'session' ? { sessionId: 'picker' } : {}) }))).status).toBe(200);
    }
    expect((await readExclusions(user, { sessionId: 'picker', now })).get(10)?.until?.getTime()).toBe(dayEnd);
    expect((await readExclusions(user, { sessionId: 'picker', now: dayEnd - 1 })).has(10)).toBe(true);
    expect((await readExclusions(user, { sessionId: 'picker', now: dayEnd })).has(10)).toBe(false);
    expect((await readExclusions(user, { now: weekEnd - 1 })).has(20)).toBe(true);
    expect([...(await readExclusions(user, { now: weekEnd })).keys()]).toEqual([30]);
    // Readers work without any cleanup writes.
    expect(Object.keys((await db.doc(paths.exclusions(user)).get()).data()!)).toHaveLength(4);
    const filter = async (at: number, sessionId?: string) => {
      const hides = await readExclusions(user, { now: at, sessionId });
      const candidates = [10, 20, 30, 40, 50].map(appid => {
        const candidate = candidateFromIndexEntry(appid, { n: 'Game', p: 0 });
        candidate.signals.history = { timesRolled: 0, lastRolledAt: null, excluded: hides.get(appid)?.scope ?? null, playedAfterRoll: false };
        return candidate;
      });
      return applyExclusions(candidates).kept.map(item => item.appid);
    };
    expect(await filter(now, 'picker')).toEqual([50]);
    expect(await filter(now, 'other')).toEqual([40, 50]);
    expect(await filter(dayEnd, 'picker')).toEqual([10, 50]);
    expect(await filter(weekEnd, 'picker')).toEqual([10, 20, 50]);
    expect(await endExclusionSession(user, 'picker', weekEnd)).toBe(1);
    expect(await filter(weekEnd, 'picker')).toEqual([10, 20, 40, 50]);
    expect(await removeExclusion(user, 30, weekEnd)).toBe(true);
    expect(await filter(weekEnd, 'picker')).toEqual([10, 20, 30, 40, 50]);
  });

  it('idempotently repeats each scope and un-hide, keeping expiry and event counts stable', async () => {
    for (const [appid, scope] of [[10, 'day'], [20, '7d'], [30, 'forever'], [40, 'session']] as const) {
      const options = { now, tz: 'America/Los_Angeles', ...(scope === 'session' ? { sessionId: 'lobby' } : {}) };
      const first = await addExclusion(user, appid, scope, options);
      expect(await addExclusion(user, appid, scope, { ...options, now: now + 1000 })).toEqual(first);
      expect((await POST(request({ action: 'unhide', appid }))).status).toBe(200);
      expect(await removeExclusion(user, appid, now)).toBe(false);
    }
    expect(await listExclusions(user, now)).toEqual([]);
    const events = await db.collection(paths.events(user)).get();
    expect(events.docs.filter(doc => doc.get('type') === 'exclude')).toHaveLength(4);
    expect(events.docs.filter(doc => doc.get('type') === 'unexclude')).toHaveLength(4);
  });

  it('ends one session only, persists past the old twelve-hour cap, and permits management of other-session hides', async () => {
    await addExclusion(user, 10, 'session', { sessionId: 'picker', now });
    await addExclusion(user, 20, 'session', { sessionId: 'lobby', now });
    expect((await readExclusions(user, { sessionId: 'picker', now: weekEnd })).has(10)).toBe(true);
    const response = await GET(new Request('https://qit.test/api/user/exclusions'));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json()).exclusions).toHaveLength(2);
    expect(await (await POST(request({ action: 'end-session', sessionId: 'picker' }))).json()).toEqual({ removed: 1 });
    expect(await endExclusionSession(user, 'picker', now)).toBe(0);
    expect((await readExclusions(user, { sessionId: 'lobby', now })).has(20)).toBe(true);
  });

  it('refuses unauthenticated and foreign or absent origins for every mutation without writes', async () => {
    const bodies = [{ action: 'hide', appid: 10, scope: 'forever' }, { action: 'unhide', appid: 10 }, { action: 'end-session', sessionId: 'picker' }];
    for (const body of bodies) {
      for (const origin of ['https://evil.test', null]) expect((await POST(request(body, origin))).status).toBe(403);
      auth.mockResolvedValue(null);
      expect((await POST(request(body))).status).toBe(401);
      expect((await GET(new Request('https://qit.test/api/user/exclusions'))).status).toBe(401);
      auth.mockResolvedValue(user);
    }
    expect((await db.doc(paths.exclusions(user)).get()).exists).toBe(false);
  });

  it('validates ids and scope, requires a profile zone, and rate limits the user', async () => {
    for (const body of [null, [], { action: 'hide', appid: 0, scope: 'day' }, { action: 'hide', appid: 10, scope: 'session' }, { action: 'end-session', sessionId: '../bad' }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    await db.doc(paths.user(user)).set({});
    expect((await POST(request({ action: 'hide', appid: 10, scope: 'day' }))).status).toBe(400);
    let last: Response | undefined;
    for (let i = 0; i < 60; i++) last = await POST(request({ action: 'unhide', appid: 10 }));
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBeTruthy();
  });
});
