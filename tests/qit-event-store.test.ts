import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countersFor } from '../src/lib/history/stats';
import { MAX_EVENT_META_BYTES, validateEvent } from '../src/lib/history/events';
import { endOfLocalDay, isValidTimeZone, localDate } from '../src/lib/history/time';
import { exclusionUntil, liveEntries } from '../src/lib/history/exclusions';
import { buildRollRecord, decodeRollCursor, encodeRollCursor, type RollInput, type RollView } from '../src/lib/history/rolls';

const { getSteamId, listRolls, markAccepted, markRerolled, markPlayed } = vi.hoisted(() => ({
  getSteamId: vi.fn(), listRolls: vi.fn(), markAccepted: vi.fn(), markRerolled: vi.fn(), markPlayed: vi.fn(),
}));
vi.mock('../src/lib/auth', () => ({ getSteamId }));
vi.mock('../src/lib/history/rolls', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/history/rolls')>(), listRolls, markAccepted, markRerolled, markPlayed,
}));

import { GET, PATCH } from '../src/app/api/history/route';

const steamId = '76561198000000042';
const friend = '76561198000000043';
const iso = (value: string) => Date.parse(value);

describe('stats counters', () => {
  it('counts every event by type and adds one dimension counter for known types', () => {
    expect(countersFor({ type: 'roll', meta: { modeId: 'dust-collector', scope: 'library' } })).toEqual(['roll', 'roll:modeId:dust-collector']);
    expect(countersFor({ type: 'played', meta: { source: 'sync' } })).toEqual(['played', 'played:source:sync']);
    expect(countersFor({ type: 'exclude', meta: { scope: '7d' } })).toEqual(['exclude', 'exclude:scope:7d']);
    expect(countersFor({ type: 'daily_accept', meta: { modeId: 'x' } })).toEqual(['daily_accept']);
  });
  it('ignores dimension values that are missing or unsafe as counter keys', () => {
    expect(countersFor({ type: 'roll' })).toEqual(['roll']);
    expect(countersFor({ type: 'roll', meta: { modeId: 'Bad.Key' } })).toEqual(['roll']);
    expect(countersFor({ type: 'roll', meta: { modeId: 7 } })).toEqual(['roll']);
  });
});

describe('validateEvent', () => {
  it('accepts well-formed events', () => {
    expect(() => validateEvent({ type: 'challenge_complete', appid: 620, refId: 'abc_123', meta: { tier: 5 } })).not.toThrow();
  });
  it('rejects malformed events', () => {
    for (const type of ['', 'Roll', '1roll', 'roll.accept', 'x'.repeat(41)]) expect(() => validateEvent({ type })).toThrow('Invalid event type');
    expect(() => validateEvent({ type: 'roll', appid: 0 })).toThrow('Invalid app ID');
    expect(() => validateEvent({ type: 'roll', refId: 'a/b' })).toThrow('Invalid document ID');
    expect(() => validateEvent({ type: 'roll', meta: [] as unknown as Record<string, unknown> })).toThrow('Invalid event meta');
    expect(() => validateEvent({ type: 'roll', meta: { big: 'x'.repeat(MAX_EVENT_META_BYTES) } })).toThrow('Event meta too large');
  });
});

describe('local day', () => {
  it('validates IANA zones', () => {
    expect(isValidTimeZone('Europe/Madrid')).toBe(true);
    expect(isValidTimeZone('Nope/Zone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
  it('ends at the next local midnight', () => {
    expect(localDate(iso('2026-09-28T02:00:00Z'), 'America/New_York')).toBe('2026-09-27');
    expect(endOfLocalDay(iso('2026-09-28T10:00:00Z'), 'America/New_York')).toBe(iso('2026-09-29T04:00:00Z'));
    expect(endOfLocalDay(iso('2026-09-28T23:30:00Z'), 'Pacific/Kiritimati')).toBe(iso('2026-09-29T10:00:00Z'));
    expect(endOfLocalDay(iso('2026-09-28T10:00:00Z'), 'Pacific/Pago_Pago')).toBe(iso('2026-09-28T11:00:00Z'));
    expect(endOfLocalDay(iso('2026-09-28T23:59:59.999Z'), 'UTC')).toBe(iso('2026-09-29T00:00:00Z'));
  });
  it('falls back to UTC for a missing or invalid zone', () => {
    expect(endOfLocalDay(iso('2026-09-28T10:00:00Z'))).toBe(iso('2026-09-29T00:00:00Z'));
    expect(endOfLocalDay(iso('2026-09-28T10:00:00Z'), 'Nope/Zone')).toBe(iso('2026-09-29T00:00:00Z'));
  });
  it('handles DST changes, including ones at midnight', () => {
    // US spring-forward and fall-back days (23 and 25 hours).
    expect(endOfLocalDay(iso('2026-03-08T12:00:00Z'), 'America/New_York')).toBe(iso('2026-03-09T04:00:00Z'));
    expect(endOfLocalDay(iso('2026-11-01T12:00:00Z'), 'America/New_York')).toBe(iso('2026-11-02T05:00:00Z'));
    // Chile skips 00:00-01:00 local on 2026-09-06: the day ends when the clock jumps to 01:00.
    expect(endOfLocalDay(iso('2026-09-05T12:00:00Z'), 'America/Santiago')).toBe(iso('2026-09-06T04:00:00Z'));
    // Chile repeats 23:00-24:00 on 2026-04-04: the day ends at the later midnight, 00:00 standard time.
    expect(endOfLocalDay(iso('2026-04-04T12:00:00Z'), 'America/Santiago')).toBe(iso('2026-04-05T04:00:00Z'));
  });
});

describe('exclusion scopes', () => {
  const now = iso('2026-09-28T10:00:00Z');
  it('computes when each scope ends', () => {
    expect(exclusionUntil('session', now)).toBeNull();
    expect(exclusionUntil('day', now, 'Europe/Madrid')).toBe(iso('2026-09-28T22:00:00Z'));
    expect(exclusionUntil('7d', now)).toBe(now + 7 * 86_400_000);
    expect(exclusionUntil('forever', now)).toBeNull();
    expect(() => exclusionUntil('month' as never, now)).toThrow('Invalid exclusion scope');
  });
  it('keeps only well-formed, unexpired entries', () => {
    const at = Timestamp.fromMillis(now - 1000);
    const later = Timestamp.fromMillis(now + 1000);
    const earlier = Timestamp.fromMillis(now - 1);
    const live = liveEntries({
      10: { scope: 'forever', at },
      20: { scope: '7d', until: later, at },
      30: { scope: 'day', until: earlier, at },
      40: { scope: 'session', until: later, at },
      50: { scope: 'session', until: later, sessionId: 's1', at },
      60: { scope: 'week', until: later, at },
      70: { scope: '7d', at },
      abc: { scope: 'forever', at },
      80: 'forever',
    }, now);
    expect([...live.keys()]).toEqual(['10', '20', '50']);
  });
});

const rollInput = (overrides: Partial<RollInput> = {}): RollInput => ({
  appid: 620, name: 'Portal 2', modeId: 'dust-collector', filters: [{ id: 'never-played' }], scope: { kind: 'library' },
  playtimeAtRoll: 0, reasons: [{ code: 'never_launched', params: {} }], ...overrides,
});

describe('buildRollRecord', () => {
  const now = iso('2026-09-28T10:00:00Z');
  it('builds a rolled record and defaults participants to the requester', () => {
    const record = buildRollRecord(steamId, rollInput(), now);
    expect(record).toEqual({
      appid: 620, name: 'Portal 2', modeId: 'dust-collector', filters: [{ id: 'never-played' }], scope: { kind: 'library' },
      participants: [steamId], at: Timestamp.fromMillis(now), status: 'rolled', playtimeAtRoll: 0,
      reasons: [{ code: 'never_launched', params: {} }],
    });
    expect('lobbyId' in record).toBe(false);
  });
  it('keeps group scopes, lobby ids and unknown playtime', () => {
    const record = buildRollRecord(steamId, rollInput({
      scope: { kind: 'friends', with: [friend] }, participants: [steamId, friend], lobbyId: 'K7QX2M', playtimeAtRoll: null,
    }), now);
    expect(record.scope).toEqual({ kind: 'friends', with: [friend] });
    expect(record.participants).toEqual([steamId, friend]);
    expect(record.lobbyId).toBe('K7QX2M');
    expect(record.playtimeAtRoll).toBeNull();
  });
  it('rejects malformed input', () => {
    const cases: Array<[Partial<RollInput>, string]> = [
      [{ appid: 0 }, 'Invalid app ID'],
      [{ modeId: 'chaos' as never }, 'Invalid mode'],
      [{ scope: { kind: 'galaxy' } as never }, 'Invalid scope'],
      [{ scope: { kind: 'pair', with: 'nobody' } as never }, 'Invalid scope'],
      [{ filters: Array.from({ length: 21 }, () => ({ id: 'playtime' as const })) }, 'Invalid filters'],
      [{ participants: [] }, 'Invalid participants'],
      [{ participants: ['123'] }, 'Invalid participants'],
      [{ reasons: Array.from({ length: 11 }, () => ({ code: 'random_pick' as const, params: {} })) }, 'Invalid reasons'],
      [{ playtimeAtRoll: -1 }, 'Invalid playtime'],
      [{ playtimeAtRoll: Number.NaN }, 'Invalid playtime'],
      [{ lobbyId: '../x' }, 'Invalid document ID'],
    ];
    for (const [overrides, message] of cases) expect(() => buildRollRecord(steamId, rollInput(overrides), now)).toThrow(message);
  });
});

describe('roll cursors', () => {
  it('round-trips the full timestamp and id', () => {
    const at = new Timestamp(1_790_000_000, 123_456_789);
    const cursor = encodeRollCursor({ id: 'AbC123', at });
    expect(cursor).toBe('1790000000.123456789.AbC123');
    expect(decodeRollCursor(cursor)).toEqual({ at, id: 'AbC123' });
  });
  it('rejects malformed cursors', () => {
    for (const cursor of ['', '1.2', '1.2.a/b', 'x.1.a', '1.1000000000.a', '1.2.a.b', '999999999999.0.abc']) expect(decodeRollCursor(cursor)).toBeNull();
  });
});

describe('/api/history', () => {
  const roll: RollView = {
    id: 'r1', appid: 620, name: 'Portal 2', modeId: 'dust-collector', filters: [], scope: { kind: 'library' }, participants: [steamId],
    lobbyId: null, at: new Date('2026-09-28T10:00:00Z'), status: 'accepted', acceptedAt: new Date('2026-09-28T10:01:00Z'),
    rerolledAt: null, playedAt: null, playedSource: null, playtimeAtRoll: 0, reasons: [],
  };
  let ip = 0;
  // A fresh client IP per request keeps the module's IP buckets out of the way.
  const headers = (extra: Record<string, string> = {}) => ({ 'x-forwarded-for': `203.0.113.${++ip % 250}`, ...extra });
  const get = (query = '') => GET(new Request(`https://qit.test/api/history${query}`, { headers: headers() }));
  const patch = (body: unknown, extra: Record<string, string> = { origin: 'https://qit.test' }) =>
    PATCH(new Request('https://qit.test/api/history', { method: 'PATCH', body: JSON.stringify(body), headers: headers(extra) }));

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.test');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const mock of [getSteamId, listRolls, markAccepted, markRerolled, markPlayed]) mock.mockReset();
    getSteamId.mockResolvedValue(steamId);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('requires a session before touching the store', async () => {
    getSteamId.mockResolvedValue(null);
    const responses = [await get(), await patch({ rollId: 'r1', action: 'accept' })];
    expect(responses.map(response => response.status)).toEqual([401, 401]);
    expect(await responses[0].json()).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required' } });
    expect(listRolls).not.toHaveBeenCalled();
    expect(markAccepted).not.toHaveBeenCalled();
  });

  it('lists the session user\'s rolls with paging', async () => {
    listRolls.mockResolvedValue({ rolls: [roll], nextCursor: '1.0.r1' });
    const response = await get('?limit=5&cursor=1790000000.0.r0');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(listRolls).toHaveBeenCalledWith(steamId, { limit: 5, cursor: '1790000000.0.r0' });
    const body = await response.json();
    expect(body.nextCursor).toBe('1.0.r1');
    expect(body.rolls[0]).toMatchObject({ id: 'r1', at: '2026-09-28T10:00:00.000Z', status: 'accepted' });
  });

  it('rejects bad paging parameters', async () => {
    for (const query of ['?limit=0', '?limit=51', '?limit=abc', '?limit=-1', '?cursor=nope']) expect((await get(query)).status).toBe(400);
    expect(listRolls).not.toHaveBeenCalled();
  });

  it('maps store failures to 502 without leaking details', async () => {
    listRolls.mockRejectedValue(new Error('secret detail'));
    const response = await get();
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
  });

  it('applies each action to the session user\'s roll', async () => {
    markAccepted.mockResolvedValue({ outcome: 'updated', roll });
    markRerolled.mockResolvedValue({ outcome: 'unchanged', roll: { ...roll, status: 'rerolled' } });
    markPlayed.mockResolvedValue({ outcome: 'updated', roll: { ...roll, playedSource: 'manual' } });
    expect((await (await patch({ rollId: 'r1', action: 'accept' })).json()).outcome).toBe('updated');
    expect((await (await patch({ rollId: 'r1', action: 'reroll' })).json()).outcome).toBe('unchanged');
    expect((await (await patch({ rollId: 'r1', action: 'played' })).json()).roll.playedSource).toBe('manual');
    expect(markAccepted).toHaveBeenCalledWith(steamId, 'r1');
    expect(markRerolled).toHaveBeenCalledWith(steamId, 'r1');
    expect(markPlayed).toHaveBeenCalledWith(steamId, 'r1', 'manual');
  });

  it('returns 404 for an unknown roll and 409 for a transition the status forbids', async () => {
    markAccepted.mockResolvedValue({ outcome: 'not_found' });
    const missing = await patch({ rollId: 'nope', action: 'accept' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'Roll not found' } });
    markRerolled.mockResolvedValue({ outcome: 'conflict', roll });
    const conflict = await patch({ rollId: 'r1', action: 'reroll' });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toEqual({ code: 'conflict', message: 'Roll is already accepted' });
  });

  it('rejects cross-site and malformed updates before touching the store', async () => {
    expect((await patch({ rollId: 'r1', action: 'accept' }, {})).status).toBe(403);
    expect((await patch({ rollId: 'r1', action: 'accept' }, { origin: 'https://evil.test' })).status).toBe(403);
    for (const body of [null, {}, { rollId: 'a/b', action: 'accept' }, { rollId: 'r1' }, { rollId: 'r1', action: 'delete' }, { rollId: 7, action: 'accept' }]) {
      expect((await patch(body)).status).toBe(400);
    }
    const tooLarge = await patch({ rollId: 'r1', action: 'accept', pad: 'x'.repeat(2000) });
    expect(tooLarge.status).toBe(413);
    expect(markAccepted).not.toHaveBeenCalled();
    expect(markRerolled).not.toHaveBeenCalled();
    expect(markPlayed).not.toHaveBeenCalled();
  });

  it('rate-limits updates per user', async () => {
    markAccepted.mockResolvedValue({ outcome: 'unchanged', roll });
    getSteamId.mockResolvedValue('76561198000000099');
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await patch({ rollId: 'r1', action: 'accept' })).status);
    expect(statuses.slice(0, 20).every(status => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
