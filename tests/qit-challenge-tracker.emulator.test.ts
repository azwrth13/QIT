import { Timestamp } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/firestore';
import { readAchievementRecord } from '../src/lib/achievements';
import {
  CHALLENGE_TTL_MS, MAX_ACTIVE_CHALLENGES, acceptChallenge, declineChallenge, expireChallenge, expireOverdueChallenges, getChallenge,
  issueChallenge, listChallenges, verifyChallenge, type ChallengeInput,
} from '../src/lib/history/challenges';
import { readStats } from '../src/lib/history/stats';
import { createSteamClient } from '../src/lib/steam/client';
import { patchLibIndex } from '../src/lib/store/lib-index';
import { paths } from '../src/lib/store/paths';

// Emulator-only (npm run test:firestore). Skipped elsewhere so it can never touch a real project.
const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;

let nextId = 0;
const freshUser = () => `7656119903${String(Date.now() % 1e5).padStart(5, '0')}${String(nextId++ % 100).padStart(2, '0')}`;
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const sec = (ms: number) => Math.floor(ms / 1000);

type Ach = { apiname: string; achieved: boolean; unlocktime?: number };
type Answer = { status: number; body: unknown };
const answer = (achievements: Ach[]): Answer => ({ status: 200, body: { playerstats: { success: true, achievements: achievements.map(a => ({
  apiname: a.apiname, achieved: a.achieved ? 1 : 0, unlocktime: a.achieved ? a.unlocktime ?? 1_700_000_000 : 0, name: `Name ${a.apiname}`, description: `Do ${a.apiname}`,
})) } } });
const privateStats: Answer = { status: 403, body: { playerstats: { success: false, error: 'Profile is not public' } } };
const noStats: Answer = { status: 400, body: { playerstats: { success: false, error: 'Requested app has no stats' } } };

/**
 * A fake Steam whose GetPlayerAchievements answer per appid can change between calls, and whose global unlock
 * percentages per appid come from `percents` (an app missing there has no stats).
 */
function fakeSteam(answers: Record<number, Answer>, percents: Record<number, Record<string, number>>) {
  const calls: number[] = [];
  const rarityCalls: number[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes('GetGlobalAchievementPercentagesForApp')) {
      const appid = Number(url.searchParams.get('gameid'));
      rarityCalls.push(appid);
      const known = percents[appid];
      if (!known) return Response.json({}, { status: 403 });
      return Response.json({ achievementpercentages: { achievements: Object.entries(known).map(([name, percent]) => ({ name, percent: String(percent) })) } });
    }
    if (!url.pathname.includes('GetPlayerAchievements')) throw new Error('Unexpected request');
    const appid = Number(url.searchParams.get('appid'));
    calls.push(appid);
    const reply = answers[appid];
    if (!reply) return Response.json({}, { status: 500 });
    return Response.json(reply.body, { status: reply.status });
  });
  return { calls, rarityCalls, answers, client: createSteamClient({ fetch: fetchMock as unknown as typeof fetch, sleep: async () => {}, retries: 0 }) };
}

const listEvents = async (steamId: string) =>
  (await db.collection(paths.events(steamId)).orderBy('at', 'asc').get()).docs.map(doc => doc.data());

/** A user owning Portal 2 (620, two locked of three; B is 8% globally, C 3%) and Steam (7, no stats). */
async function setup(answers: Record<number, Answer> = {}) {
  const steamId = freshUser();
  await patchLibIndex(steamId, { 620: { n: 'Portal 2', p: 600 }, 7: { n: 'Steam', p: 0 } }, { create: true });
  const steam = fakeSteam({
    620: answer([{ apiname: 'A', achieved: true }, { apiname: 'B', achieved: false }, { apiname: 'C', achieved: false }]),
    ...answers,
  }, { 620: { A: 80, B: 8, C: 3 } });
  return { steamId, steam };
}

const target: ChallengeInput = { kind: 'achievement', appid: 620, apiname: 'B' };

async function issued(steamId: string, client: ReturnType<typeof fakeSteam>['client'], input: ChallengeInput = target, now = NOW) {
  const result = await issueChallenge(steamId, input, { now, client });
  if (result.outcome !== 'created') throw new Error(`issue ${result.outcome}`);
  return result.challenge;
}

beforeEach(() => { vi.stubEnv('STEAM_API_KEY', 'emulator-test-key'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe.skipIf(!emulated)('challenge lifecycle (emulator)', () => {
  it('issues a challenge for a locked achievement, storing the target and the game data', async () => {
    const { steamId, steam } = await setup();
    const challenge = await issued(steamId, steam.client);
    expect(challenge).toMatchObject({
      kind: 'achievement', appid: 620, name: 'Portal 2', apiname: 'B', achievementName: 'Name B', achievementDescription: 'Do B',
      status: 'issued', acceptedAt: null, threshold: null,
    });
    expect(challenge.expiresAt.getTime()).toBe(NOW + CHALLENGE_TTL_MS.offer);
    expect(await getChallenge(steamId, challenge.id)).toEqual(challenge);
    // The Steam answer was stored through the achievements data, so a second issue costs no call.
    expect((await readAchievementRecord(steamId, 620))?.progress).toEqual({ unlocked: 1, total: 3, percent: 33 });
    await issued(steamId, steam.client, { kind: 'achievement', appid: 620, apiname: 'C' });
    expect(steam.calls).toEqual([620]);
    expect(steam.rarityCalls).toEqual([]);
    const events = await listEvents(steamId);
    expect(events.map(event => [event.type, event.refId, event.meta])).toEqual([
      ['challenge_issue', challenge.id, { kind: 'achievement' }], ['challenge_issue', expect.any(String), { kind: 'achievement' }],
    ]);
  });

  it('refuses challenges that cannot be completed or would duplicate an open one', async () => {
    const { steamId, steam } = await setup({ 7: noStats });
    const issue = (input: ChallengeInput) => issueChallenge(steamId, input, { now: NOW, client: steam.client });
    expect((await issue({ kind: 'achievement', appid: 730, apiname: 'B' })).outcome).toBe('not_owned');
    expect((await issue({ kind: 'achievement', appid: 7, apiname: 'B' })).outcome).toBe('no_achievements');
    expect((await issue({ kind: 'achievement', appid: 620, apiname: 'A' })).outcome).toBe('not_locked');
    expect((await issue({ kind: 'achievement', appid: 620, apiname: 'Z' })).outcome).toBe('not_locked');
    expect((await issueChallenge(freshUser(), target, { now: NOW, client: steam.client })).outcome).toBe('needs_sync');
  });

  it('lets one achievement back at most one active challenge, whatever its kind', async () => {
    const { steamId, steam } = await setup();
    const issue = (input: ChallengeInput) => issueChallenge(steamId, input, { now: NOW, client: steam.client });
    const first = await issued(steamId, steam.client);
    const rare = await issued(steamId, steam.client, { kind: 'rare', appid: 620, apiname: 'C', threshold: 5 });
    const callsBefore = [steam.calls.length, steam.rarityCalls.length];
    // The same request returns the open challenge; any other request on that achievement is a conflict.
    expect(await issue(target)).toMatchObject({ outcome: 'existing', challenge: { id: first.id } });
    expect(await issue({ kind: 'rare', appid: 620, apiname: 'B', threshold: 10 })).toMatchObject({ outcome: 'conflict', challenge: { id: first.id } });
    expect(await issue({ kind: 'rare', appid: 620, apiname: 'C', threshold: 5 })).toMatchObject({ outcome: 'existing', challenge: { id: rare.id } });
    expect(await issue({ kind: 'rare', appid: 620, apiname: 'C', threshold: 25 })).toMatchObject({ outcome: 'conflict', challenge: { id: rare.id } });
    expect(await issue({ kind: 'achievement', appid: 620, apiname: 'C' })).toMatchObject({ outcome: 'conflict', challenge: { id: rare.id } });
    // The pre-check answers before any Steam call.
    expect([steam.calls.length, steam.rarityCalls.length]).toEqual(callsBefore);
    // Once the challenge is closed, the achievement is free again.
    await declineChallenge(steamId, first.id, NOW + 1);
    expect((await issue({ kind: 'rare', appid: 620, apiname: 'B', threshold: 10 })).outcome).toBe('created');
  });

  it('dedupes racing issues for one achievement in the transaction', async () => {
    const { steamId, steam } = await setup();
    const issue = (input: ChallengeInput) => issueChallenge(steamId, input, { now: NOW, client: steam.client });
    const rareC: ChallengeInput = { kind: 'rare', appid: 620, apiname: 'C', threshold: 5 };
    const same = await Promise.all([issue(rareC), issue(rareC)]);
    expect(same.map(result => result.outcome).sort()).toEqual(['created', 'existing']);
    const different = await Promise.all([issue(target), issue({ kind: 'rare', appid: 620, apiname: 'B', threshold: 10 })]);
    expect(different.map(result => result.outcome).sort()).toEqual(['conflict', 'created']);
    const active = (await listChallenges(steamId, { status: 'active', now: NOW })).challenges;
    expect(active.map(challenge => challenge.apiname).sort()).toEqual(['B', 'C']);
    expect((await listEvents(steamId)).filter(event => event.type === 'challenge_issue')).toHaveLength(2);
  });

  it('issues a rare challenge only when Steam\'s global unlock percent is at or below the tier', async () => {
    const { steamId, steam } = await setup();
    const issue = (input: ChallengeInput) => issueChallenge(steamId, input, { now: NOW, client: steam.client });
    // B is unlocked by 8% of players: not rare enough for the 5% tier.
    expect((await issue({ kind: 'rare', appid: 620, apiname: 'B', threshold: 5 })).outcome).toBe('not_rare');
    expect(await issue({ kind: 'rare', appid: 620, apiname: 'B', threshold: 10 })).toMatchObject({ outcome: 'created', challenge: { kind: 'rare', threshold: 10 } });
    // A game without global stats on Steam cannot back a rare challenge.
    await patchLibIndex(steamId, { 440: { n: 'Team Fortress 2', p: 0 } }, { create: true });
    steam.answers[440] = answer([{ apiname: 'X', achieved: false }]);
    expect((await issue({ kind: 'rare', appid: 440, apiname: 'X', threshold: 25 })).outcome).toBe('not_rare');
    expect(steam.rarityCalls).toEqual([620, 620, 440]);
  });

  it('caps the open challenges per user, counting overdue ones as closed', async () => {
    const { steamId, steam } = await setup();
    const many = answer([...Array(MAX_ACTIVE_CHALLENGES + 1)].map((_, i) => ({ apiname: `L${i}`, achieved: false })));
    steam.answers[620] = many;
    for (let i = 0; i < MAX_ACTIVE_CHALLENGES; i++) await issued(steamId, steam.client, { kind: 'achievement', appid: 620, apiname: `L${i}` });
    const last = { kind: 'achievement', appid: 620, apiname: `L${MAX_ACTIVE_CHALLENGES}` } as const;
    expect((await issueChallenge(steamId, last, { now: NOW, client: steam.client })).outcome).toBe('limit');
    // Once the offers lapse they no longer count, even before a sweep writes them as expired.
    const later = NOW + CHALLENGE_TTL_MS.offer;
    expect((await issueChallenge(steamId, last, { now: later, client: steam.client })).outcome).toBe('created');
  });

  it('moves issued -> accepted -> completed, counting only unlocks at or after acceptance, and emits the completion once', async () => {
    const { steamId, steam } = await setup();
    const challenge = await issued(steamId, steam.client);
    // Mid-second, so the acceptance second starts 500 ms before acceptance.
    const acceptAt = NOW + 60_500;
    const accepted = await acceptChallenge(steamId, challenge.id, acceptAt);
    expect(accepted.outcome).toBe('updated');
    expect(accepted.outcome !== 'not_found' && accepted.challenge).toMatchObject({ status: 'accepted' });
    expect(accepted.outcome !== 'not_found' && accepted.challenge.acceptedAt?.getTime()).toBe(acceptAt);
    expect(accepted.outcome !== 'not_found' && accepted.challenge.expiresAt.getTime()).toBe(acceptAt + CHALLENGE_TTL_MS.achievement);
    expect((await acceptChallenge(steamId, challenge.id, acceptAt + 1)).outcome).toBe('unchanged');

    // Unlocked between issue and acceptance: does not count.
    steam.answers[620] = answer([{ apiname: 'A', achieved: true }, { apiname: 'B', achieved: true, unlocktime: sec(acceptAt) - 1 }, { apiname: 'C', achieved: false }]);
    const early = await verifyChallenge(steamId, challenge.id, { now: acceptAt + 120_000, client: steam.client });
    expect(early).toMatchObject({ outcome: 'pending', progress: { unlocked: 0, required: 1 }, challenge: { status: 'accepted' } });
    // Another achievement unlocked after acceptance does not count for a targeted challenge either.
    steam.answers[620] = answer([{ apiname: 'B', achieved: false }, { apiname: 'C', achieved: true, unlocktime: sec(acceptAt) + 5 }]);
    expect((await verifyChallenge(steamId, challenge.id, { now: acceptAt + 180_000, client: steam.client })).outcome).toBe('pending');

    // Unlocked in the acceptance second: counts.
    steam.answers[620] = answer([{ apiname: 'B', achieved: true, unlocktime: sec(acceptAt) }, { apiname: 'C', achieved: true, unlocktime: sec(acceptAt) + 5 }]);
    const doneAt = acceptAt + 240_000;
    const done = await verifyChallenge(steamId, challenge.id, { now: doneAt, client: steam.client });
    expect(done.outcome).toBe('updated');
    expect(done.outcome === 'updated' && done.challenge).toMatchObject({ status: 'completed', unlocks: [{ apiname: 'B', unlocktime: sec(acceptAt) }] });
    expect((await getChallenge(steamId, challenge.id))?.completedAt?.getTime()).toBe(doneAt);
    // The verify refreshed the game's achievement data.
    expect((await readAchievementRecord(steamId, 620))?.progress).toEqual({ unlocked: 2, total: 2, percent: 100 });

    // Verifying again does not call Steam or complete twice.
    const callsBefore = steam.calls.length;
    expect((await verifyChallenge(steamId, challenge.id, { now: doneAt + 1, client: steam.client })).outcome).toBe('unchanged');
    expect(steam.calls).toHaveLength(callsBefore);

    const events = await listEvents(steamId);
    expect(events.map(event => event.type)).toEqual(['challenge_issue', 'challenge_accept', 'challenge_complete']);
    expect(events[2]).toMatchObject({ appid: 620, refId: challenge.id, meta: { kind: 'achievement', unlocks: 1 } });
    expect((await readStats(steamId)).counters).toEqual({
      challenge_issue: 1, challenge_accept: 1, challenge_complete: 1, 'challenge_complete:kind:achievement': 1,
    });
  });

  it('completes a rare challenge with its threshold, and only the challenge on the unlocked achievement', async () => {
    const { steamId, steam } = await setup();
    const hunt = await issued(steamId, steam.client);
    const rare = await issued(steamId, steam.client, { kind: 'rare', appid: 620, apiname: 'C', threshold: 5 });
    await acceptChallenge(steamId, hunt.id, NOW + 1000);
    const accepted = await acceptChallenge(steamId, rare.id, NOW + 1000);
    expect(accepted.outcome !== 'not_found' && accepted.challenge.expiresAt.getTime()).toBe(NOW + 1000 + CHALLENGE_TTL_MS.rare);
    const at = sec(NOW + 1000);
    steam.answers[620] = answer([{ apiname: 'A', achieved: true, unlocktime: at - 100 }, { apiname: 'B', achieved: false }, { apiname: 'C', achieved: true, unlocktime: at + 20 }]);
    expect(await verifyChallenge(steamId, hunt.id, { now: NOW + 5000, client: steam.client })).toMatchObject({ outcome: 'pending', progress: { unlocked: 0, required: 1 } });
    const done = await verifyChallenge(steamId, rare.id, { now: NOW + 6000, client: steam.client });
    expect(done.outcome === 'updated' && done.challenge.unlocks).toEqual([{ apiname: 'C', unlocktime: at + 20 }]);
    expect((await readStats(steamId)).counters).toMatchObject({ challenge_complete: 1, 'challenge_complete:kind:rare': 1 });
    expect((await listEvents(steamId)).filter(event => event.type === 'challenge_complete').map(event => event.meta))
      .toEqual([{ kind: 'rare', threshold: 5, unlocks: 1 }]);
  });

  it('completes once when verify calls race', async () => {
    const { steamId, steam } = await setup();
    const challenge = await issued(steamId, steam.client);
    await acceptChallenge(steamId, challenge.id, NOW + 1000);
    steam.answers[620] = answer([{ apiname: 'B', achieved: true, unlocktime: sec(NOW) + 60 }]);
    const results = await Promise.all([...Array(5)].map((_, i) => verifyChallenge(steamId, challenge.id, { now: NOW + 100_000 + i, client: steam.client })));
    const outcomes = results.map(result => result.outcome);
    expect(outcomes.filter(outcome => outcome === 'updated')).toHaveLength(1);
    expect(outcomes.every(outcome => outcome === 'updated' || outcome === 'unchanged')).toBe(true);
    expect((await listEvents(steamId)).filter(event => event.type === 'challenge_complete')).toHaveLength(1);
    expect((await readStats(steamId)).counters.challenge_complete).toBe(1);
  });

  it('declines an issued challenge and rejects every illegal transition', async () => {
    const { steamId, steam } = await setup();
    const a = await issued(steamId, steam.client);
    const b = await issued(steamId, steam.client, { kind: 'achievement', appid: 620, apiname: 'C' });

    // Verify before acceptance is illegal: nothing is fetched or completed.
    steam.calls.length = 0;
    expect(await verifyChallenge(steamId, a.id, { now: NOW + 1, client: steam.client })).toMatchObject({ outcome: 'conflict', challenge: { status: 'issued' } });
    expect(steam.calls).toEqual([]);

    expect((await declineChallenge(steamId, a.id, NOW + 10)).outcome).toBe('updated');
    expect((await declineChallenge(steamId, a.id, NOW + 11)).outcome).toBe('unchanged');
    expect((await acceptChallenge(steamId, a.id, NOW + 12))).toMatchObject({ outcome: 'conflict', challenge: { status: 'declined' } });
    expect((await verifyChallenge(steamId, a.id, { now: NOW + 13, client: steam.client })).outcome).toBe('conflict');

    await acceptChallenge(steamId, b.id, NOW + 20);
    expect((await declineChallenge(steamId, b.id, NOW + 21))).toMatchObject({ outcome: 'conflict', challenge: { status: 'accepted' } });
    // Expiry before the deadline is illegal too.
    expect((await expireChallenge(steamId, b.id, NOW + 22))).toMatchObject({ outcome: 'conflict', challenge: { status: 'accepted' } });

    expect((await acceptChallenge(steamId, 'missing')).outcome).toBe('not_found');
    expect((await declineChallenge(steamId, 'missing')).outcome).toBe('not_found');
    expect((await verifyChallenge(steamId, 'missing', { client: steam.client })).outcome).toBe('not_found');
    expect(await getChallenge(steamId, a.id)).toMatchObject({ status: 'declined', acceptedAt: null });
    expect((await getChallenge(steamId, a.id))?.declinedAt?.getTime()).toBe(NOW + 10);
    expect((await listEvents(steamId)).map(event => event.type))
      .toEqual(['challenge_issue', 'challenge_issue', 'challenge_decline', 'challenge_accept']);
  });

  it('expires lapsed offers and attempts on the next touch, list or sweep', async () => {
    const { steamId, steam } = await setup({ 620: answer([{ apiname: 'B', achieved: false }, { apiname: 'C', achieved: false }, { apiname: 'D', achieved: false }]) });
    const offer = await issued(steamId, steam.client);
    const attempt = await issued(steamId, steam.client, { kind: 'achievement', appid: 620, apiname: 'D' });
    const swept = await issued(steamId, steam.client, { kind: 'rare', appid: 620, apiname: 'C', threshold: 25 });
    await acceptChallenge(steamId, attempt.id, NOW + 1000);
    await acceptChallenge(steamId, swept.id, NOW + 1000);

    // Accepting a lapsed offer expires it instead.
    const lapsed = NOW + CHALLENGE_TTL_MS.offer;
    expect(await acceptChallenge(steamId, offer.id, lapsed)).toMatchObject({ outcome: 'conflict', challenge: { status: 'expired' } });
    expect((await getChallenge(steamId, offer.id))?.expiredAt?.getTime()).toBe(lapsed);

    // A verify after the attempt window expires it without asking Steam, even if the unlock is there.
    steam.answers[620] = answer([{ apiname: 'D', achieved: true, unlocktime: sec(NOW) + 10 }]);
    steam.calls.length = 0;
    const late = NOW + 1000 + CHALLENGE_TTL_MS.achievement;
    expect(await verifyChallenge(steamId, attempt.id, { now: late, client: steam.client })).toMatchObject({ outcome: 'conflict', challenge: { status: 'expired' } });
    expect(steam.calls).toEqual([]);
    expect(await expireChallenge(steamId, attempt.id, late + 1)).toMatchObject({ outcome: 'unchanged', challenge: { status: 'expired' } });

    // The rare attempt (14 days) is still open at the 7-day mark, then a list sweeps it.
    const listed = await listChallenges(steamId, { status: 'active', now: late });
    expect(listed.challenges.map(challenge => challenge.id)).toEqual([swept.id]);
    const end = NOW + 1000 + CHALLENGE_TTL_MS.rare;
    expect(await expireOverdueChallenges(steamId, end - 1)).toEqual([]);
    expect((await listChallenges(steamId, { status: 'active', now: end })).challenges).toEqual([]);
    expect(await getChallenge(steamId, swept.id)).toMatchObject({ status: 'expired' });

    const expired = (await listEvents(steamId)).filter(event => event.type === 'challenge_expire');
    expect(expired.map(event => [event.refId, event.meta.from])).toEqual([[offer.id, 'issued'], [attempt.id, 'accepted'], [swept.id, 'accepted']]);
    expect((await readStats(steamId)).counters.challenge_expire).toBe(3);
  });

  it('reports private achievements on verify without completing, and asks Steam again only after the recheck', async () => {
    const { steamId, steam } = await setup();
    const challenge = await issued(steamId, steam.client);
    await acceptChallenge(steamId, challenge.id, NOW + 1000);
    steam.answers[620] = privateStats;
    steam.calls.length = 0;
    expect(await verifyChallenge(steamId, challenge.id, { now: NOW + 2000, client: steam.client })).toMatchObject({ outcome: 'private', challenge: { status: 'accepted' } });
    expect((await verifyChallenge(steamId, challenge.id, { now: NOW + 3000, client: steam.client })).outcome).toBe('private');
    expect(steam.calls).toEqual([620]);
    // Issuing for another game while private is refused without a call as well.
    expect((await issueChallenge(steamId, { kind: 'achievement', appid: 7, apiname: 'B' }, { now: NOW + 4000, client: steam.client })).outcome).toBe('private');
    expect(steam.calls).toEqual([620]);
  });

  it('lists every challenge newest first with paging', async () => {
    const { steamId, steam } = await setup({ 620: answer([{ apiname: 'B', achieved: false }, { apiname: 'C', achieved: false }, { apiname: 'D', achieved: false }]) });
    const inputs: ChallengeInput[] = [target, { kind: 'achievement', appid: 620, apiname: 'D' }, { kind: 'rare', appid: 620, apiname: 'C', threshold: 25 }];
    const ids: string[] = [];
    for (const [i, input] of inputs.entries()) ids.push((await issued(steamId, steam.client, input, NOW + i)).id);
    // Give two challenges the same issue time to exercise the id tiebreak.
    await db.doc(paths.challenge(steamId, ids[2])).update({ issuedAt: Timestamp.fromMillis(NOW + 1) });
    const first = await listChallenges(steamId, { limit: 2, now: NOW + 10 });
    expect(first.challenges).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listChallenges(steamId, { limit: 2, cursor: first.nextCursor!, now: NOW + 10 });
    const seen = [...first.challenges, ...second.challenges].map(challenge => challenge.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...ids].sort());
    expect(second.nextCursor).toBeNull();
    expect(first.challenges[0].issuedAt.getTime()).toBeGreaterThanOrEqual(first.challenges[1].issuedAt.getTime());
  });
});

describe.skipIf(!emulated)('challenge completion event (emulator)', () => {
  it('lands in the event log with the challenge id, so streaks and stats can read it', async () => {
    const { steamId, steam } = await setup();
    const challenge = await issued(steamId, steam.client, { kind: 'rare', appid: 620, apiname: 'B', threshold: 10 });
    await acceptChallenge(steamId, challenge.id, NOW);
    steam.answers[620] = answer([{ apiname: 'B', achieved: true, unlocktime: sec(NOW) + 1 }]);
    await verifyChallenge(steamId, challenge.id, { now: NOW + DAY, client: steam.client });
    const snapshot = await db.collection(paths.events(steamId)).where('type', '==', 'challenge_complete').get();
    expect(snapshot.docs.map(doc => doc.data())).toEqual([
      { type: 'challenge_complete', at: Timestamp.fromMillis(NOW + DAY), appid: 620, refId: challenge.id, meta: { kind: 'rare', threshold: 10, unlocks: 1 } },
    ]);
  });
});
