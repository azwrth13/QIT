import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHALLENGE_STATUSES, TRANSITIONS, canTransition, evaluateChallenge, isOverdue, qualifyingUnlocks, toChallengeView, validateChallengeInput,
  type ChallengeView,
} from '../src/lib/history/challenges';
import { countersFor } from '../src/lib/history/stats';
import { SteamClientError } from '../src/lib/steam/client';
import type { PlayerAchievement } from '../src/lib/steam/achievements';

const { getSteamId, listChallenges, issueChallenge, acceptChallenge, declineChallenge, verifyChallenge } = vi.hoisted(() => ({
  getSteamId: vi.fn(), listChallenges: vi.fn(), issueChallenge: vi.fn(), acceptChallenge: vi.fn(), declineChallenge: vi.fn(), verifyChallenge: vi.fn(),
}));
vi.mock('../src/lib/auth', () => ({ getSteamId }));
vi.mock('../src/lib/history/challenges', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/history/challenges')>(), listChallenges, issueChallenge, acceptChallenge, declineChallenge, verifyChallenge,
}));

import { GET, PATCH, POST } from '../src/app/api/challenges/route';

const steamId = '76561198000000042';
const ACCEPTED = Date.parse('2026-10-01T12:00:00.500Z');
const acceptedSecond = Math.floor(ACCEPTED / 1000);

const unlocked = (apiname: string, unlocktime: number | null): PlayerAchievement => ({ apiname, achieved: true, unlocktime });
const locked = (apiname: string): PlayerAchievement => ({ apiname, achieved: false, unlocktime: null });

describe('challenge state machine', () => {
  it('allows exactly the lifecycle moves', () => {
    const legal = CHALLENGE_STATUSES.flatMap(from => CHALLENGE_STATUSES.filter(to => canTransition(from, to)).map(to => `${from}->${to}`));
    expect(legal.sort()).toEqual([
      'accepted->completed', 'accepted->expired', 'issued->accepted', 'issued->declined', 'issued->expired',
    ]);
    for (const terminal of ['completed', 'declined', 'expired'] as const) expect(TRANSITIONS[terminal]).toEqual([]);
  });

  it('treats only active challenges past their expiry as overdue', () => {
    const at = new Date(ACCEPTED);
    expect(isOverdue({ status: 'issued', expiresAt: at }, ACCEPTED)).toBe(true);
    expect(isOverdue({ status: 'accepted', expiresAt: at }, ACCEPTED - 1)).toBe(false);
    expect(isOverdue({ status: 'completed', expiresAt: at }, ACCEPTED + 1)).toBe(false);
    expect(isOverdue({ status: 'declined', expiresAt: at }, ACCEPTED + 1)).toBe(false);
  });
});

describe('validateChallengeInput', () => {
  it('accepts the two kinds and normalizes them', () => {
    expect(validateChallengeInput({ kind: 'achievement', appid: 620, apiname: 'ACH_X' })).toEqual({ kind: 'achievement', appid: 620, apiname: 'ACH_X' });
    expect(validateChallengeInput({ kind: 'rare', appid: 620, apiname: 'ACH_X', threshold: 5 })).toEqual({ kind: 'rare', appid: 620, apiname: 'ACH_X', threshold: 5 });
  });

  it('rejects malformed input', () => {
    const bad: unknown[] = [
      null, {}, { kind: 'hunt', appid: 620, apiname: 'X' }, { kind: 'any', appid: 620 }, { kind: 'any', appid: 620, apiname: 'X' },
      { kind: 'achievement', appid: '620', apiname: 'X' }, { kind: 'achievement', appid: 0, apiname: 'X' }, { kind: 'achievement', appid: 1.5, apiname: 'X' },
      { kind: 'achievement', appid: 620 }, { kind: 'achievement', appid: 620, apiname: '' }, { kind: 'achievement', appid: 620, apiname: 'x'.repeat(129) },
      { kind: 'achievement', appid: 620, apiname: 'X', threshold: 5 },
      { kind: 'rare', appid: 620, apiname: 'X' }, { kind: 'rare', appid: 620, apiname: 'X', threshold: 50 },
    ];
    for (const input of bad) expect(() => validateChallengeInput(input as never), JSON.stringify(input)).toThrow();
  });
});

describe('challenge verification rules', () => {
  const targeted = { apiname: 'B', acceptedAt: new Date(ACCEPTED) };

  it('counts an unlock only at or after the acceptance second', () => {
    expect(evaluateChallenge(targeted, [unlocked('B', acceptedSecond - 1)])).toMatchObject({ met: false, progress: { unlocked: 0, required: 1 } });
    expect(evaluateChallenge(targeted, [unlocked('B', acceptedSecond)])).toEqual({
      met: true, progress: { unlocked: 1, required: 1 }, unlocks: [{ apiname: 'B', unlocktime: acceptedSecond }],
    });
    expect(evaluateChallenge(targeted, [unlocked('B', acceptedSecond + 3600)]).met).toBe(true);
  });

  it('ignores locked achievements, unknown unlock times and other achievements for a targeted challenge', () => {
    expect(evaluateChallenge(targeted, [locked('B'), unlocked('C', acceptedSecond + 1)]).met).toBe(false);
    expect(evaluateChallenge(targeted, [unlocked('B', null)]).met).toBe(false);
    expect(evaluateChallenge(targeted, [{ apiname: 'B', achieved: false, unlocktime: acceptedSecond + 1 }]).met).toBe(false);
  });

  it('is never met before acceptance', () => {
    expect(evaluateChallenge({ ...targeted, acceptedAt: null }, [unlocked('B', acceptedSecond + 1)])).toEqual({ met: false, progress: { unlocked: 0, required: 1 }, unlocks: [] });
  });

  it('takes only the target achievement from a full game answer', () => {
    const achievements = [unlocked('A', acceptedSecond + 10), unlocked('B', acceptedSecond + 20), unlocked('C', acceptedSecond + 30)];
    expect(qualifyingUnlocks(targeted, achievements, ACCEPTED)).toEqual([{ apiname: 'B', unlocktime: acceptedSecond + 20 }]);
  });

  it('counts completions per kind in the stats summary', () => {
    expect(countersFor({ type: 'challenge_complete', meta: { kind: 'rare', threshold: 5 } })).toEqual(['challenge_complete', 'challenge_complete:kind:rare']);
    expect(countersFor({ type: 'challenge_accept', meta: { kind: 'rare' } })).toEqual(['challenge_accept']);
  });
});

describe('toChallengeView', () => {
  const issuedAt = Timestamp.fromMillis(ACCEPTED);
  const expiresAt = Timestamp.fromMillis(ACCEPTED + 1000);

  it('reads a stored challenge', () => {
    expect(toChallengeView('c1', {
      kind: 'rare', appid: 620, name: 'Portal 2', apiname: 'B', achievementName: 'Bee', threshold: 10, status: 'completed', issuedAt, expiresAt,
      acceptedAt: issuedAt, completedAt: expiresAt, unlocks: [{ apiname: 'B', unlocktime: 5 }, { apiname: 7 }],
    })).toEqual({
      id: 'c1', kind: 'rare', appid: 620, name: 'Portal 2', apiname: 'B', achievementName: 'Bee', achievementDescription: null, threshold: 10,
      status: 'completed', issuedAt: issuedAt.toDate(), acceptedAt: issuedAt.toDate(), completedAt: expiresAt.toDate(), declinedAt: null, expiredAt: null,
      expiresAt: expiresAt.toDate(), unlocks: [{ apiname: 'B', unlocktime: 5 }],
    });
  });

  it('returns null for missing or malformed essentials', () => {
    const base = { kind: 'achievement', appid: 620, apiname: 'B', status: 'issued', issuedAt, expiresAt };
    expect(toChallengeView('c1', base)?.apiname).toBe('B');
    expect(toChallengeView('c1', undefined)).toBeNull();
    for (const broken of [{ kind: 'any' }, { status: 'done' }, { appid: '620' }, { apiname: undefined }, { issuedAt: 'yesterday' }, { expiresAt: null }]) {
      expect(toChallengeView('c1', { ...base, ...broken })).toBeNull();
    }
  });
});

describe('/api/challenges', () => {
  const challenge: ChallengeView = {
    id: 'c1', kind: 'achievement', appid: 620, name: 'Portal 2', apiname: 'B', achievementName: 'Bee', achievementDescription: null, threshold: null,
    status: 'accepted', issuedAt: new Date('2026-10-01T12:00:00Z'), acceptedAt: new Date('2026-10-01T12:01:00Z'), completedAt: null,
    declinedAt: null, expiredAt: null, expiresAt: new Date('2026-10-08T12:01:00Z'), unlocks: [],
  };
  let ip = 0;
  let users = 0;
  let user = steamId;
  // A fresh client IP per request keeps the module's IP buckets out of the way.
  const headers = (extra: Record<string, string> = {}) => ({ 'x-forwarded-for': `203.0.113.${++ip % 250}`, ...extra });
  const same = { origin: 'https://qit.test' };
  const get = (query = '') => GET(new Request(`https://qit.test/api/challenges${query}`, { headers: headers() }));
  const send = (method: 'POST' | 'PATCH', body: unknown, extra: Record<string, string> = same) =>
    (method === 'POST' ? POST : PATCH)(new Request('https://qit.test/api/challenges', { method, body: JSON.stringify(body), headers: headers(extra) }));
  const mocks = [getSteamId, listChallenges, issueChallenge, acceptChallenge, declineChallenge, verifyChallenge];

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.test');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const mock of mocks) mock.mockReset();
    // A fresh user per test keeps the module's per-user buckets from carrying over.
    user = `7656119800000${String(1000 + ++users)}`;
    getSteamId.mockResolvedValue(user);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('requires a session before touching the store', async () => {
    getSteamId.mockResolvedValue(null);
    const responses = [await get(), await send('POST', { kind: 'achievement', appid: 620, apiname: 'B' }), await send('PATCH', { challengeId: 'c1', action: 'verify' })];
    expect(responses.map(response => response.status)).toEqual([401, 401, 401]);
    for (const mock of mocks.slice(1)) expect(mock).not.toHaveBeenCalled();
  });

  it('lists the session user\'s challenges', async () => {
    listChallenges.mockResolvedValue({ challenges: [challenge], nextCursor: null });
    const response = await get('?status=active');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(listChallenges).toHaveBeenCalledWith(user, { status: 'active', limit: 20, cursor: undefined });
    expect((await response.json()).challenges[0]).toMatchObject({ id: 'c1', status: 'accepted', acceptedAt: '2026-10-01T12:01:00.000Z' });
    await get('?limit=5&cursor=1790000000.0.c0');
    expect(listChallenges).toHaveBeenLastCalledWith(user, { status: 'all', limit: 5, cursor: '1790000000.0.c0' });
  });

  it('rejects bad list parameters', async () => {
    for (const query of ['?status=open', '?limit=0', '?limit=51', '?cursor=nope', '?status=active&cursor=1790000000.0.c0']) expect((await get(query)).status).toBe(400);
    expect(listChallenges).not.toHaveBeenCalled();
  });

  it('issues a validated challenge for the session user', async () => {
    issueChallenge.mockResolvedValue({ outcome: 'created', challenge: { ...challenge, status: 'issued' } });
    const created = await send('POST', { kind: 'rare', appid: 620, apiname: 'B', threshold: 10 });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ outcome: 'created', challenge: { id: 'c1', status: 'issued' } });
    expect(issueChallenge).toHaveBeenCalledWith(user, { kind: 'rare', appid: 620, apiname: 'B', threshold: 10 });
    issueChallenge.mockResolvedValue({ outcome: 'existing', challenge });
    expect((await send('POST', { kind: 'rare', appid: 620, apiname: 'B', threshold: 10 })).status).toBe(200);
    issueChallenge.mockResolvedValue({ outcome: 'conflict', challenge });
    const taken = await send('POST', { kind: 'rare', appid: 620, apiname: 'B', threshold: 5 });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { code: 'conflict' }, challenge: { id: 'c1' } });
  });

  it('maps issue refusals to 404 and 409 with a code', async () => {
    const cases = [['not_owned', 404], ['needs_sync', 409], ['private', 409], ['no_achievements', 409], ['not_locked', 409], ['not_rare', 409], ['limit', 409]] as const;
    for (const [outcome, status] of cases) {
      issueChallenge.mockResolvedValue({ outcome });
      const response = await send('POST', { kind: 'achievement', appid: 620, apiname: 'B' });
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(outcome);
    }
  });

  it('rejects cross-site and malformed issues before touching the store', async () => {
    expect((await send('POST', { kind: 'achievement', appid: 620, apiname: 'B' }, {})).status).toBe(403);
    expect((await send('POST', { kind: 'achievement', appid: 620, apiname: 'B' }, { origin: 'https://evil.test' })).status).toBe(403);
    for (const body of [null, [], {}, { kind: 'any', appid: 620 }, { kind: 'achievement', appid: '620', apiname: 'B' }, { kind: 'rare', appid: 620, apiname: 'B', threshold: 50 }]) {
      expect((await send('POST', body)).status).toBe(400);
    }
    expect((await send('POST', { kind: 'achievement', appid: 620, apiname: 'B', pad: 'x'.repeat(2000) })).status).toBe(413);
    expect(issueChallenge).not.toHaveBeenCalled();
  });

  it('applies each action to the session user\'s challenge', async () => {
    acceptChallenge.mockResolvedValue({ outcome: 'updated', challenge });
    declineChallenge.mockResolvedValue({ outcome: 'unchanged', challenge: { ...challenge, status: 'declined' } });
    verifyChallenge.mockResolvedValue({ outcome: 'updated', challenge: { ...challenge, status: 'completed' } });
    expect((await (await send('PATCH', { challengeId: 'c1', action: 'accept' })).json()).outcome).toBe('updated');
    expect((await (await send('PATCH', { challengeId: 'c1', action: 'decline' })).json()).outcome).toBe('unchanged');
    expect((await (await send('PATCH', { challengeId: 'c1', action: 'verify' })).json()).challenge.status).toBe('completed');
    expect(acceptChallenge).toHaveBeenCalledWith(user, 'c1');
    expect(declineChallenge).toHaveBeenCalledWith(user, 'c1');
    expect(verifyChallenge).toHaveBeenCalledWith(user, 'c1');
  });

  it('reports pending, private, missing and conflicting verifies', async () => {
    verifyChallenge.mockResolvedValue({ outcome: 'pending', challenge, progress: { unlocked: 0, required: 1 } });
    expect(await (await send('PATCH', { challengeId: 'c1', action: 'verify' })).json()).toMatchObject({ outcome: 'pending', progress: { unlocked: 0, required: 1 } });
    verifyChallenge.mockResolvedValue({ outcome: 'private', challenge });
    const privateBody = await (await send('PATCH', { challengeId: 'c1', action: 'verify' })).json();
    expect(privateBody.outcome).toBe('private');
    expect(privateBody.message).toContain('Game details');
    verifyChallenge.mockResolvedValue({ outcome: 'not_found' });
    expect((await send('PATCH', { challengeId: 'c1', action: 'verify' })).status).toBe(404);
    verifyChallenge.mockResolvedValue({ outcome: 'conflict', challenge: { ...challenge, status: 'expired' } });
    const conflict = await send('PATCH', { challengeId: 'c1', action: 'verify' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'conflict', message: 'Challenge is already expired' }, challenge: { status: 'expired' } });
  });

  it('maps Steam throttling to 429 and other failures to 502 without leaking details', async () => {
    verifyChallenge.mockRejectedValue(new SteamClientError('rate_limited', 429, 12));
    const throttled = await send('PATCH', { challengeId: 'c1', action: 'verify' });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('12');
    verifyChallenge.mockRejectedValue(new Error('secret detail'));
    const failed = await send('PATCH', { challengeId: 'c1', action: 'verify' });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain('secret');
  });

  it('rejects cross-site and malformed updates before touching the store', async () => {
    expect((await send('PATCH', { challengeId: 'c1', action: 'accept' }, {})).status).toBe(403);
    for (const body of [null, {}, { challengeId: 'a/b', action: 'accept' }, { challengeId: 'c1' }, { challengeId: 'c1', action: 'complete' }]) {
      expect((await send('PATCH', body)).status).toBe(400);
    }
    for (const mock of [acceptChallenge, declineChallenge, verifyChallenge]) expect(mock).not.toHaveBeenCalled();
  });

  it('rate-limits verifies per user more tightly than other updates', async () => {
    verifyChallenge.mockResolvedValue({ outcome: 'unchanged', challenge });
    acceptChallenge.mockResolvedValue({ outcome: 'unchanged', challenge });
    const verifies: number[] = [];
    for (let i = 0; i < 11; i++) verifies.push((await send('PATCH', { challengeId: 'c1', action: 'verify' })).status);
    expect(verifies.slice(0, 10).every(status => status === 200)).toBe(true);
    expect(verifies[10]).toBe(429);
    expect((await send('PATCH', { challengeId: 'c1', action: 'accept' })).status).toBe(200);
  });
});
