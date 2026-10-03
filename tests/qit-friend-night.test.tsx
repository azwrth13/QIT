import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/auth', () => ({ getSteamId: vi.fn() }));
vi.mock('../src/lib/social/libraries', () => ({ getLibraryFor: vi.fn() }));
vi.mock('../src/lib/roulette/service', () => ({ DEFAULT_DEPS: {}, SOURCED_FAMILIES: new Set(['library', 'store', 'live', 'history', 'group']) }));
import { getSteamId } from '../src/lib/auth';
import { getLibraryFor } from '../src/lib/social/libraries';
import { POST } from '../src/app/api/friend-night/route';
import { friendNight } from '../src/lib/friend-night/service';
import { matchesDiscovery } from '../src/lib/friend-night/model';
import { IndividualPlaytime, PlayerProgress } from '../src/app/friend-night/PlayerProgress';
import { FriendNight } from '../src/app/friend-night/FriendNight';
import { parseSpinRequest } from '../src/lib/roulette/request';
import { THRESHOLDS } from '../src/lib/roulette/thresholds';
import { DEFAULT_DEPS } from '../src/lib/roulette/service';
import type { Candidate, GroupSignals } from '../src/lib/roulette/types';
import type { PipelineDeps } from '../src/lib/roulette/pipeline';

const self = '76561198000000001', friend = '76561198000000002';
const group = (...minutes: Array<number | null>): GroupSignals => ({ members: minutes.map((playtimeForever, i) => ({ steamId: i ? friend : self, owns: true, playtimeForever })) });
const candidate = (appid: number, minutes: Array<number | null>): Candidate => ({ appid, signals: {
  library: { name: `Game ${appid}`, iconHash: null, playtimeForever: minutes[0] ?? 0, playtime2Weeks: 0, lastPlayedAt: null }, group: group(...minutes),
} });
function dependencies(candidates: Candidate[], unavailable: Array<{ steamId: string; state: 'private' }> = []): PipelineDeps {
  return { resolvers: { friends: { kind: 'friends', provides: ['group', 'store'], resolve: vi.fn(async () => ({ candidates, members: [self, friend], unavailable })) } },
    loaders: { live: async games => { for (const game of games) game.signals.live = { players: 150, band: 'high' }; } },
    recordRoll: vi.fn(async () => 'roll'), headerArt: async () => null, now: () => 1000000, randomSeed: () => 'seed', thresholds: THRESHOLDS, logError: vi.fn() };
}
function request() {
  const result = parseSpinRequest({ mode: 'everyone-owns-it', scope: { kind: 'friends', with: [friend] } }, 'spin', new Set(['library', 'store', 'group', 'history', 'live']));
  if (!result.ok) throw new Error(result.error);
  return result.request;
}
describe('Friend Night discovery and pipeline', () => {
  it('applies all group discovery predicates without treating hidden playtime as zero', () => {
    expect(matchesDiscovery(group(0, 0), 'nobody', 10)).toBe(true);
    expect(matchesDiscovery(group(null, 0), 'nobody', 10)).toBe(false);
    expect(matchesDiscovery(group(null, 0), 'one-new', 10)).toBe(true);
    expect(matchesDiscovery(group(599, 0), 'under-hours', 10)).toBe(true);
    expect(matchesDiscovery(group(600, 0), 'under-hours', 10)).toBe(false);
    expect(matchesDiscovery(group(600, 0), 'veteran', 10)).toBe(true);
    expect(matchesDiscovery(group(600, 1), 'veteran', 10)).toBe(false);
    expect(matchesDiscovery(group(1, 1), 'everyone-played', 10)).toBe(true);
    expect(matchesDiscovery(group(null, 1), 'everyone-played', 10)).toBe(false);
  });
  it('filters before drawing, persists through the shared event writer, and returns picked playtime and reasons', async () => {
    const deps = dependencies([candidate(10, [60, 60]), candidate(20, [0, 60])]);
    const result = await friendNight(self, request(), 'spin', 'one-new', 10, deps);
    expect('card' in result && result.card?.appid).toBe(20);
    expect('card' in result && result.card?.reasons.map(r => r.code)).toEqual(['friends_all_own', 'friends_never_played', 'active_now']);
    expect(result.members).toEqual(group(0, 60).members);
    expect(deps.recordRoll).toHaveBeenCalledWith(self, expect.objectContaining({ appid: 20, participants: [self, friend] }), 1000000);
  });
  it('returns an empty pool for unavailable or nonmatching groups without recording a roll', async () => {
    const deps = dependencies([], [{ steamId: friend, state: 'private' }]);
    const result = await friendNight(self, request(), 'spin', 'any', 10, deps);
    expect(result.unavailable).toEqual([{ steamId: friend, state: 'private' }]);
    expect('card' in result && result.card).toBeNull();
    expect(deps.recordRoll).not.toHaveBeenCalled();
    const empty = await friendNight(self, request(), 'pool', 'nobody', 10, dependencies([candidate(10, [1, 1])]));
    expect(empty.eligible).toBe(0);
  });
  it('keeps missing counters and hidden playtime unknown in the result', async () => {
    const deps = dependencies([candidate(10, [null, null])]);
    deps.loaders.live = async games => { for (const game of games) game.signals.live = { players: null, band: null }; };
    const result = await friendNight(self, request(), 'spin', 'any', 10, deps);
    expect(result.card?.live).toEqual({ players: null, band: null });
    expect(result.card?.reasons.map(r => r.code)).toEqual(['friends_all_own']);
    expect(result.members.every(m => m.playtimeForever === null)).toBe(true);
  });
});

describe('Friend Night page fixtures', () => {
  it('renders individual known, never-played and hidden playtime with profile names or ID fallback', () => {
    const html = renderToStaticMarkup(<IndividualPlaytime steamId={self} names={{ [friend]: 'Pal' }} members={[
      ...group(null, 0).members, { steamId: 'other', owns: true, playtimeForever: 120 },
    ]} />);
    expect(html).toContain('You: Unknown / hidden');
    expect(html).toContain('Pal: Never launched');
    expect(html).toContain('other: 2h');
  });
  it('renders initial loading and empty selection', () => {
    const html = renderToStaticMarkup(<FriendNight steamId={self} />);
    expect(html).toContain('Loading Steam friends');
    expect(html).toContain('Select at least one friend');
    expect(html).toContain('Never played together');
  });
  it('renders partial libraries, private exclusion, empty accessible libraries and retryable errors', () => {
    const html = renderToStaticMarkup(<PlayerProgress players={[
      { steamId: self, name: 'Ready', state: 'ok', count: 0 },
      { steamId: friend, name: 'Private', state: 'private' },
      { steamId: '3', name: 'Waiting', state: 'loading' },
      { steamId: '4', name: 'Failed', state: 'error' },
      { steamId: '5', name: 'Missing', state: 'not_found' },
    ]} onRemove={() => {}} />);
    for (const text of ['0 owned games', 'Private library', 'Loading library', 'retry loading', 'Profile not found', 'Remove Private from this group']) expect(html).toContain(text);
  });
});

describe('Friend Night API', () => {
  let sequence = 0;
  beforeEach(() => { vi.resetAllMocks(); sequence++; vi.mocked(getSteamId).mockResolvedValue(`765611980${String(sequence + 100).padStart(8, '0')}`); });
  const post = (body: unknown, origin: string | null = 'https://qit.example') => POST(new Request('https://qit.example/api/friend-night', {
    method: 'POST', headers: { ...(origin ? { origin } : {}), 'x-forwarded-for': `192.0.2.${sequence}` }, body: JSON.stringify(body),
  }));
  it('refuses unauthenticated, cross-origin and missing-Origin requests before Steam access', async () => {
    vi.mocked(getSteamId).mockResolvedValueOnce(null);
    expect((await post({ action: 'library', steamId: friend })).status).toBe(401);
    expect((await post({ action: 'library', steamId: friend }, 'https://evil.example')).status).toBe(403);
    expect((await post({ action: 'library', steamId: friend }, null)).status).toBe(403);
    expect(getLibraryFor).not.toHaveBeenCalled();
  });
  it.each(['ok', 'private', 'not_found', 'error'] as const)('returns per-player %s state without transferring library games', async state => {
    vi.mocked(getLibraryFor).mockResolvedValueOnce([{ steamId: friend, state, source: 'steam', games: new Map(), fetchedAt: null }]);
    const response = await post({ action: 'library', steamId: friend });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ steamId: friend, state, count: state === 'ok' ? 0 : null });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('rejects invalid actions, scopes, discovery values and body size', async () => {
    for (const body of [{ action: 'library', steamId: 'invalid' }, { action: 'pool', scope: { kind: 'library' } }, { action: 'spin', discovery: 'bad' }, { action: 'spin', hours: -1 }, { action: 'bad' }]) expect((await post(body)).status).toBe(400);
    expect((await post({ action: 'library', steamId: friend, extra: 'x'.repeat(17000) })).status).toBe(413);
  });
  it('executes pool and spin with the friends scope and shared writer', async () => {
    const deps = dependencies([candidate(20, [0, 60])]);
    Object.assign(DEFAULT_DEPS, deps);
    const input = { mode: 'everyone-owns-it', scope: { kind: 'friends', with: [friend] }, discovery: 'one-new', hours: 10 };
    const pool = await post({ ...input, action: 'pool' });
    expect(pool.status).toBe(200);
    expect((await pool.json()).eligible).toBe(1);
    expect(deps.recordRoll).not.toHaveBeenCalled();
    const spin = await post({ ...input, action: 'spin' });
    expect(spin.status).toBe(200);
    expect((await spin.json()).card.appid).toBe(20);
    expect(deps.recordRoll).toHaveBeenCalledOnce();
  });
  it('hides upstream errors and limits library requests per user', async () => {
    vi.mocked(getLibraryFor).mockRejectedValue(new Error('secret Steam detail'));
    const response = await post({ action: 'library', steamId: friend });
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
    vi.mocked(getLibraryFor).mockResolvedValue([{ steamId: friend, state: 'private', games: new Map(), source: 'steam', fetchedAt: null }]);
    for (let i = 0; i < 29; i++) expect((await post({ action: 'library', steamId: friend })).status).toBe(200);
    const limited = await post({ action: 'library', steamId: friend });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
