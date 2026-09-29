import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SteamApiError } from '../src/lib/steam';
import {
  classifySteamStatus, createSemaphore, createSteamClient, getSteamClient, parseRetryAfter, setSteamClient, SteamClientError,
  type SteamClientOptions,
} from '../src/lib/steam/client';
import { createDailyBudget, firestoreBudgetStore, memoryBudgetStore, utcDay, type BudgetStore } from '../src/lib/steam/budget';
import {
  steamHeaderImageUrl, steamIconUrl, steamKeyedUrl, steamKeylessUrl, steamLibraryCapsuleUrl, steamStoreUrl,
} from '../src/lib/steam/urls';
import { getOwnedGames, getRecentlyPlayedGames } from '../src/lib/steam/owned';
import { getFriendList, getPlayerSummaries, resolveVanityUrl } from '../src/lib/steam/players';
import { getPlayerAchievements, getSchemaForGame } from '../src/lib/steam/achievements';
import { getGlobalAchievementPercentages } from '../src/lib/steam/rarity';
import { getCurrentPlayers, getGamesByConcurrentPlayers } from '../src/lib/steam/charts';
import { getAppDetails, getStoreItems, STORE_ITEMS_BATCH } from '../src/lib/steam/store';

const steamId = '76561198000000000';
const KEY = 'test-key-do-not-leak';

type Answer = Response | Error | (() => Response | Promise<Response>);

function harness(answers: Answer[], options: SteamClientOptions = {}) {
  const queue = [...answers];
  const urls: URL[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(new URL(String(input)));
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  const client = createSteamClient({
    fetch: fetchMock as unknown as typeof fetch,
    random: () => 0.5,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    ...options,
  });
  return { client, fetchMock, urls, sleeps, advance: (ms: number) => { clock += ms; } };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });

beforeEach(() => vi.stubEnv('STEAM_API_KEY', KEY));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setSteamClient(null); });

describe('URL builders', () => {
  it('keyed URLs carry the key and validate Steam IDs', () => {
    const url = steamKeyedUrl('/IPlayerService/GetOwnedGames/v1/', { steamid: steamId });
    expect(url.origin).toBe('https://api.steampowered.com');
    expect(url.searchParams.get('key')).toBe(KEY);
    expect(() => steamKeyedUrl('/IPlayerService/GetOwnedGames/v1/', { steamid: '123' })).toThrow('Invalid Steam ID');
  });
  it('keyless URLs never carry the key, even when it is configured', () => {
    const url = steamKeylessUrl('/ISteamUserStats/GetNumberOfCurrentPlayers/v1/', { appid: '730' });
    expect(url.searchParams.has('key')).toBe(false);
    expect(url.toString()).not.toContain(KEY);
    expect(() => steamKeylessUrl('/ISteamUserStats/GetNumberOfCurrentPlayers/v1/', { KEY: 'x' })).toThrow('must not carry a key');
    expect(() => steamStoreUrl('/api/appdetails', { key: 'x' })).toThrow('must not carry a key');
    vi.stubEnv('STEAM_API_KEY', '');
    expect(() => steamKeylessUrl('/IStoreService/GetTagList/v1/')).not.toThrow();
  });
  it('rejects paths that could change the host', () => {
    for (const path of ['//evil.test/x/y/v1/', 'https://evil.test/ISteamUser/GetFriendList/v1/', '/ISteamUser/GetFriendList/v1/../../x']) {
      expect(() => steamKeylessUrl(path)).toThrow('Invalid Steam API path');
      expect(() => steamKeyedUrl(path, {})).toThrow('Invalid Steam API path');
    }
  });
  it('builds art URLs and rejects malformed inputs', () => {
    expect(steamHeaderImageUrl(620)).toBe('https://cdn.cloudflare.steamstatic.com/steam/apps/620/header.jpg');
    expect(steamLibraryCapsuleUrl(620)).toBe('https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900.jpg');
    expect(steamIconUrl(620, '25a5a16b2423bf7487ac5340b5b0948cef48c5f8'))
      .toBe('https://media.steampowered.com/steamcommunity/public/images/apps/620/25a5a16b2423bf7487ac5340b5b0948cef48c5f8.jpg');
    expect(steamIconUrl(620, '../x')).toBeNull();
    expect(() => steamHeaderImageUrl(0)).toThrow('Invalid app ID');
  });
});

describe('error taxonomy and Retry-After', () => {
  it('classifies statuses', () => {
    expect([401, 403, 404, 429, 400, 414, 408, 500, 503, 0].map(classifySteamStatus)).toEqual(
      ['private', 'unavailable', 'not_found', 'rate_limited', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable']);
  });
  it('parses delta seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
  it('client errors are SteamApiErrors without URL, key or body in the message', async () => {
    const { client } = harness([new Response('secret body', { status: 404 })]);
    const error = await client.json(steamKeyedUrl('/ISteamUser/GetFriendList/v1/', { steamid: steamId })).catch(e => e) as SteamClientError;
    expect(error).toBeInstanceOf(SteamApiError);
    expect(error).toMatchObject({ kind: 'not_found', status: 404, message: 'Steam request failed' });
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/key|secret|steampowered/);
  });
});

describe('retry', () => {
  const url = () => steamKeylessUrl('/IStoreService/GetTagList/v1/');

  it('retries 5xx and network errors with jittered exponential backoff', async () => {
    const { client, fetchMock, sleeps } = harness([new Response('', { status: 503 }), new TypeError('fetch failed'), json({ ok: 1 })]);
    expect(await client.json(url())).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([200, 400]); // random 0.5 * 400 * 2^attempt
    expect(client.stats()).toMatchObject({ requests: 3, retries: 2, keyless: 3, keyed: 0 });
  });
  it('treats timeouts as unavailable and gives up after the retry limit', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { client, fetchMock } = harness([timeout, timeout, timeout]);
    await expect(client.json(url())).rejects.toMatchObject({ kind: 'unavailable', status: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('does not retry client errors', async () => {
    const { client, fetchMock } = harness([new Response('', { status: 400 })]);
    await expect(client.json(url())).rejects.toMatchObject({ kind: 'unavailable', status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('honors Retry-After on 429', async () => {
    const { client, sleeps } = harness([new Response('', { status: 429, headers: { 'Retry-After': '2' } }), json({ ok: 1 })]);
    expect(await client.json(url())).toEqual({ ok: 1 });
    expect(sleeps).toEqual([2000 + 200]);
  });
  it('fails fast when Retry-After is longer than the configured cap, reporting the wait', async () => {
    const { client, fetchMock } = harness([new Response('', { status: 429, headers: { 'Retry-After': '60' } })]);
    await expect(client.json(url())).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterSeconds: 60 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('stops retrying when the next wait would pass the deadline', async () => {
    const { client, fetchMock } = harness([new Response('', { status: 429 }), new Response('', { status: 429 })], { deadlineMs: 150 });
    await expect(client.json(url())).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('returns accepted non-2xx statuses with parsed or null data', async () => {
    const { client } = harness([json({ a: 1 }, 404), new Response('<html>', { status: 403 })]);
    expect(await client.request(url(), { accept: [404] })).toEqual({ status: 404, data: { a: 1 } });
    expect(await client.request(url(), { accept: [403] })).toEqual({ status: 403, data: null });
  });
  it('rejects a 2xx answer that is not JSON', async () => {
    const { client, fetchMock } = harness([new Response('<html>', { status: 200 })]);
    await expect(client.json(url())).rejects.toMatchObject({ kind: 'unavailable', status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('the shared client uses the global fetch at call time', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ response: { player_count: 5, result: 1 } }));
    expect(getSteamClient()).toBe(getSteamClient());
    expect(await getCurrentPlayers(730)).toBe(5);
  });
});

describe('concurrency', () => {
  it('semaphore caps active tasks and runs waiters in order', async () => {
    const semaphore = createSemaphore(2);
    const order: number[] = [];
    const gates: Array<() => void> = [];
    const tasks = [0, 1, 2, 3].map(i => semaphore.run(() => new Promise<void>(resolve => gates.push(() => { order.push(i); resolve(); }))));
    await Promise.resolve();
    expect(semaphore.active).toBe(2);
    expect(semaphore.waiting).toBe(2);
    gates[0](); await tasks[0];
    gates[1](); await tasks[1];
    await vi.waitFor(() => expect(gates.length).toBe(4));
    gates[2](); gates[3]();
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(semaphore.active).toBe(0);
  });
  it('client never has more than `concurrency` requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = () => {
      inFlight++; peak = Math.max(peak, inFlight);
      return new Promise<Response>(resolve => setTimeout(() => { inFlight--; resolve(json({})); }, 5));
    };
    const { client } = harness(Array.from({ length: 12 }, () => slow), { concurrency: 3 });
    await Promise.all(Array.from({ length: 12 }, () => client.json(steamKeylessUrl('/IStoreService/GetTagList/v1/'))));
    expect(peak).toBe(3);
  });
});

describe('daily budget', () => {
  it('counts only keyed calls and refuses without calling Steam once exhausted', async () => {
    const budget = createDailyBudget({ limit: 2, block: 1 });
    const { client, fetchMock } = harness([json({}), json({}), json({})], { budget });
    const keyed = () => steamKeyedUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId });
    await client.json(keyed());
    await client.json(steamKeylessUrl('/IStoreService/GetTagList/v1/'));
    await client.json(keyed());
    await expect(client.json(keyed())).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(budget.status()).toMatchObject({ exhausted: true, localTokens: 0 });
  });
  it('spends one unit per attempt, so retries count against the quota', async () => {
    const store = memoryBudgetStore();
    const budget = createDailyBudget({ limit: 10, block: 1, store, now: () => 0 });
    const { client } = harness([new Response('', { status: 500 }), json({})], { budget });
    await client.json(steamKeyedUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }));
    expect(store.used(utcDay(0))).toBe(2);
  });
  it('instances sharing a store never exceed the global limit and reserve in blocks', async () => {
    const store = memoryBudgetStore();
    const reserve = vi.spyOn(store, 'reserve');
    const a = createDailyBudget({ limit: 23, block: 5, store, now: () => 0 });
    const b = createDailyBudget({ limit: 23, block: 5, store, now: () => 0 });
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).take()));
    expect(results.filter(Boolean)).toHaveLength(23);
    expect(store.used(utcDay(0))).toBe(23);
    expect(reserve.mock.calls.length).toBeLessThanOrEqual(8);
  });
  it('resets on a new UTC day', async () => {
    let time = Date.UTC(2026, 8, 28, 23, 59);
    const budget = createDailyBudget({ limit: 1, block: 1, now: () => time });
    expect(await budget.take()).toBe(true);
    expect(await budget.take()).toBe(false);
    time += 2 * 60 * 1000;
    expect(await budget.take()).toBe(true);
    expect(budget.status().day).toBe('2026-09-29');
  });
  it('fails open when the store is unreachable', async () => {
    const store: BudgetStore = { reserve: vi.fn().mockRejectedValue(new Error('firestore down')) };
    const budget = createDailyBudget({ limit: 10, block: 3, store });
    expect(await budget.take()).toBe(true);
    expect(budget.status().localTokens).toBe(2);
    expect(store.reserve).toHaveBeenCalledTimes(1);
  });
  it('firestoreBudgetStore reserves inside a transaction and records an expiry', async () => {
    const docs = new Map<string, Record<string, unknown>>();
    const ref = {
      id: '2026-09-28',
      firestore: {
        runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({
          get: async (r: typeof ref) => ({ get: (field: string) => docs.get(r.id)?.[field] }),
          set: (r: typeof ref, data: Record<string, unknown>) => docs.set(r.id, { ...docs.get(r.id), ...data }),
        }),
      },
    };
    const store = firestoreBudgetStore(() => ref as never);
    expect(await store.reserve('2026-09-28', 5, 7)).toBe(5);
    expect(await store.reserve('2026-09-28', 5, 7)).toBe(2);
    expect(await store.reserve('2026-09-28', 5, 7)).toBe(0);
    expect(docs.get('2026-09-28')).toMatchObject({ used: 7, day: '2026-09-28', expiresAt: new Date('2026-09-30T00:00:00Z') });
  });
});

describe('owned games', () => {
  it('requests free games and normalizes optional fields', async () => {
    const { client, urls } = harness([json({ response: { game_count: 3, games: [
      { appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 600, playtime_2weeks: 30, rtime_last_played: 1700000000, has_community_visible_stats: true },
      { appid: 10, name: 'Never', playtime_forever: 0, rtime_last_played: 0 },
      { appid: 'bad' },
    ] } })]);
    const result = await getOwnedGames(steamId, { appids: [620, 10] }, client);
    expect(result).toEqual({ state: 'public', gameCount: 3, games: [
      { appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_forever: 600, playtime_2weeks: 30, rtime_last_played: 1700000000, has_community_visible_stats: true },
      { appid: 10, name: 'Never', img_icon_url: '', playtime_forever: 0, playtime_2weeks: 0, rtime_last_played: 0, has_community_visible_stats: false },
    ] });
    const params = urls[0].searchParams;
    expect(params.get('include_appinfo')).toBe('1');
    expect(params.get('include_played_free_games')).toBe('1');
    expect(params.get('appids_filter[0]')).toBe('620');
    expect(params.get('appids_filter[1]')).toBe('10');
  });
  it('distinguishes private from an empty public library', async () => {
    const { client, urls } = harness([json({ response: {} }), json({ response: { game_count: 0 } })]);
    expect(await getOwnedGames(steamId, {}, client)).toEqual({ state: 'private' });
    expect(await getOwnedGames(steamId, { includeAppInfo: false, includePlayedFreeGames: false }, client)).toEqual({ state: 'public', gameCount: 0, games: [] });
    expect(urls[1].searchParams.get('include_appinfo')).toBe('0');
    expect(urls[1].searchParams.get('include_played_free_games')).toBe('0');
    await expect(getOwnedGames('1', {}, client)).rejects.toThrow('Invalid Steam ID');
  });
  it('recently played games', async () => {
    const { client, urls } = harness([
      json({ response: { total_count: 1, games: [{ appid: 620, name: 'Portal 2', playtime_2weeks: 30, playtime_forever: 600, img_icon_url: 'abc' }] } }),
      json({ response: {} }),
    ]);
    expect(await getRecentlyPlayedGames(steamId, 5, client)).toEqual({ state: 'public', totalCount: 1, games: [
      { appid: 620, name: 'Portal 2', img_icon_url: 'abc', playtime_2weeks: 30, playtime_forever: 600 },
    ] });
    expect(urls[0].searchParams.get('count')).toBe('5');
    expect(await getRecentlyPlayedGames(steamId, undefined, client)).toEqual({ state: 'private' });
  });
  it('a key-block 403 is an error, never a cached private state', async () => {
    const block = () => new Response('<html><head><title>Forbidden</title></head><body>Access is denied.</body></html>', { status: 403 });
    const { client } = harness([block(), block(), json({}, 403)]);
    await expect(getOwnedGames(steamId, {}, client)).rejects.toMatchObject({ kind: 'unavailable', status: 403 });
    await expect(getRecentlyPlayedGames(steamId, undefined, client)).rejects.toMatchObject({ kind: 'unavailable', status: 403 });
    expect(await getRecentlyPlayedGames(steamId, undefined, client)).toEqual({ state: 'private' });
  });
});

describe('players', () => {
  it('batches summaries by 100 and drops invalid IDs', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `76561198${String(i).padStart(9, '0')}`);
    const answer = (batch: string[]) => json({ response: { players: batch.map(id => ({ steamid: id, personaname: id, profileurl: '', communityvisibilitystate: 3, personastate: 1 })) } });
    const { client, urls } = harness([answer(ids.slice(0, 100)), answer(ids.slice(100, 200)), answer(ids.slice(200))]);
    const summaries = await getPlayerSummaries([...ids, ids[0], 'nope'], client);
    expect(summaries.size).toBe(250);
    expect(urls.map(url => url.searchParams.get('steamids')!.split(',').length)).toEqual([100, 100, 50]);
    expect(summaries.get(ids[5])).toMatchObject({ personastate: 1 });
  });
  it('friend list: 401, a JSON 403 and a missing list are private; an HTML 403 throws', async () => {
    const { client } = harness([
      json({ friendslist: { friends: [{ steamid: '76561198000000001', friend_since: 5 }, { steamid: '76561198000000001' }, { steamid: 'x' }] } }),
      new Response('<html>Unauthorized</html>', { status: 401 }), json({}, 403), json({}),
      new Response('<html>Forbidden</html>', { status: 403 }),
    ]);
    expect(await getFriendList(steamId, client)).toEqual({ state: 'public', friends: [{ steamid: '76561198000000001', friend_since: 5 }] });
    for (let i = 0; i < 3; i++) expect(await getFriendList(steamId, client)).toEqual({ state: 'private' });
    await expect(getFriendList(steamId, client)).rejects.toMatchObject({ kind: 'unavailable', status: 403 });
  });
  it('resolves vanity names', async () => {
    const { client, urls } = harness([json({ response: { success: 1, steamid: steamId } }), json({ response: { success: 42, message: 'No match' } })]);
    expect(await resolveVanityUrl('gaben', client)).toBe(steamId);
    expect(urls[0].searchParams.get('vanityurl')).toBe('gaben');
    expect(await resolveVanityUrl('nobody', client)).toBeNull();
    expect(await resolveVanityUrl('bad name&key=x', client)).toBeNull();
    expect(urls).toHaveLength(2);
  });
});

describe('achievements', () => {
  it('parses achievements with language fields', async () => {
    const { client, urls } = harness([json({ playerstats: { success: true, achievements: [
      { apiname: 'A', achieved: 1, unlocktime: 1700000000, name: 'First', description: 'Do it' },
      { apiname: 'B', achieved: 0, unlocktime: 0, name: 'Hidden', description: '' },
    ] } })]);
    expect(await getPlayerAchievements(steamId, 620, 'english', client)).toEqual({ state: 'ok', achievements: [
      { apiname: 'A', achieved: true, unlocktime: 1700000000, name: 'First', description: 'Do it' },
      { apiname: 'B', achieved: false, unlocktime: null, name: 'Hidden', description: '' },
    ] });
    expect(urls[0].searchParams.get('l')).toBe('english');
  });
  it('maps Steam 400 and 403 bodies, and rejects untrusted error bodies', async () => {
    const { client } = harness([
      json({ playerstats: { success: false, error: 'Requested app has no stats' } }, 400),
      json({ playerstats: { success: false, error: 'Profile is not public' } }, 403),
      json({ playerstats: { success: true } }),
      new Response('<html>Forbidden</html>', { status: 403 }),
      json({}),
    ]);
    expect(await getPlayerAchievements(steamId, 1, 'english', client)).toEqual({ state: 'no_stats' });
    expect(await getPlayerAchievements(steamId, 1, 'english', client)).toEqual({ state: 'private' });
    expect(await getPlayerAchievements(steamId, 1, 'english', client)).toEqual({ state: 'no_stats' });
    await expect(getPlayerAchievements(steamId, 1, 'english', client)).rejects.toMatchObject({ kind: 'unavailable', status: 403 });
    await expect(getPlayerAchievements(steamId, 1, 'english', client)).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('reads the schema, marking hidden achievements', async () => {
    const { client } = harness([
      json({ game: { gameName: 'x', availableGameStats: { achievements: [
        { name: 'A', displayName: 'First', description: 'Do it', hidden: 0, icon: 'i', icongray: 'g' },
        { name: 'B', displayName: 'Secret', hidden: 1, icon: 'i2' },
      ] } } }),
      json({ game: {} }),
    ]);
    expect(await getSchemaForGame(620, 'english', client)).toEqual([
      { name: 'A', displayName: 'First', description: 'Do it', hidden: false, icon: 'i', icongray: 'g' },
      { name: 'B', displayName: 'Secret', hidden: true, icon: 'i2' },
    ]);
    expect(await getSchemaForGame(7, 'english', client)).toEqual([]);
  });
});

describe('keyless endpoints', () => {
  it('global rarity parses string percents; a JSON 403 means no stats, an HTML 403 throws', async () => {
    const { client, urls } = harness([
      json({ achievementpercentages: { achievements: [{ name: 'ACH.A', percent: '74.1' }, { name: 'ACH.B', percent: 5 }, { name: 'ACH.C', percent: 'x' }] } }),
      json({}, 403),
      new Response('<html>Forbidden</html>', { status: 403 }),
    ]);
    expect(await getGlobalAchievementPercentages(620, client)).toEqual([{ apiname: 'ACH.A', percent: 74.1 }, { apiname: 'ACH.B', percent: 5 }]);
    expect(await getGlobalAchievementPercentages(7, client)).toBeNull();
    await expect(getGlobalAchievementPercentages(620, client)).rejects.toMatchObject({ kind: 'unavailable', status: 403 });
    expect(urls.every(url => !url.searchParams.has('key'))).toBe(true);
    expect(urls[0].searchParams.get('gameid')).toBe('620');
  });
  it('current players: a missing counter is unknown, not zero', async () => {
    const { client } = harness([json({ response: { player_count: 0, result: 1 } }), json({ response: { result: 42 } }, 404)]);
    expect(await getCurrentPlayers(730, client)).toBe(0);
    expect(await getCurrentPlayers(1, client)).toBeNull();
  });
  it('charts', async () => {
    const { client } = harness([
      json({ response: { last_update: 10, ranks: [{ rank: 1, appid: 730, concurrent_in_game: 5, peak_in_game: 9 }, { rank: 2 }] } }),
    ]);
    expect(await getGamesByConcurrentPlayers(client)).toEqual({ lastUpdate: 10, ranks: [{ rank: 1, appid: 730, concurrent_in_game: 5, peak_in_game: 9 }] });
  });
  it('store items: batches of 100, matched by id, delisted apps are null', async () => {
    const appids = Array.from({ length: 250 }, (_, i) => i + 1);
    const answer = (batch: number[]) => json({ response: { store_items: batch.map(id => id === 7
      ? { item_type: 0, id, success: 15, visible: false, name: '', appid: 0 }
      : { item_type: 0, id, success: 1, visible: true, name: `App ${id}`, appid: id, type: 0, tagids: [19],
        tags: [{ tagid: 19, weight: 600 }], categories: { supported_player_categoryids: [2, 1], feature_categoryids: [22] },
        release: { steam_release_date: 1303186800 }, reviews: { summary_filtered: { review_count: 1, percent_positive: 98, review_score: 9, review_score_label: 'Overwhelmingly Positive' } },
        assets: { asset_url_format: `steam/apps/${id}/\${FILENAME}`, header: 'header.jpg' }, related_items: { parent_appid: 620 } }) } });
    const { client, urls } = harness([answer(appids.slice(0, 100)), answer(appids.slice(100, 200)), answer(appids.slice(200))]);
    const items = await getStoreItems([...appids, 1], {}, client);
    expect(STORE_ITEMS_BATCH).toBe(100);
    expect(urls).toHaveLength(3);
    expect(urls.every(url => !url.searchParams.has('key'))).toBe(true);
    const input = JSON.parse(urls[0].searchParams.get('input_json')!);
    expect(input.ids).toHaveLength(100);
    expect(input.data_request).toMatchObject({ include_release: true, include_tag_count: 20 });
    expect(items.size).toBe(250);
    expect(items.get(7)).toBeNull();
    expect(items.get(8)).toEqual({
      appid: 8, name: 'App 8', type: 0, visible: true, tagids: [19], tags: [{ tagid: 19, weight: 600 }],
      categories: { supported_player_categoryids: [2, 1], feature_categoryids: [22], controller_categoryids: [] },
      releaseDate: 1303186800, reviews: { review_count: 1, percent_positive: 98, review_score: 9, review_score_label: 'Overwhelmingly Positive' },
      assets: { asset_url_format: 'steam/apps/8/${FILENAME}', header: 'header.jpg' }, parentAppid: 620,
    });
    await expect(getStoreItems([0], {}, client)).rejects.toThrow('Invalid app ID');
  });
  it('appdetails', async () => {
    const { client, urls } = harness([
      json({ 620: { success: true, data: { name: 'Portal 2', genres: [{ description: 'Action' }] } } }),
      json({ 1: { success: false } }),
    ]);
    expect(await getAppDetails(620, { filters: 'genres' }, client)).toEqual({ name: 'Portal 2', genres: [{ description: 'Action' }] });
    expect(urls[0].origin).toBe('https://store.steampowered.com');
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ appids: '620', cc: 'us', filters: 'genres' });
    expect(await getAppDetails(1, {}, client)).toBeNull();
  });
});

describe('SteamClientError', () => {
  it('keeps kind and optional retry hint', () => {
    const error = new SteamClientError('rate_limited', 429, 3);
    expect(error).toBeInstanceOf(SteamApiError);
    expect(error).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterSeconds: 3 });
    expect('retryAfterSeconds' in new SteamClientError('unavailable')).toBe(false);
  });
});
