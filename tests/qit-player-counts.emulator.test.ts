import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { APP_LIVE_TTL_MS, getCurrentPlayers } from '../src/lib/apps/live-players';
import { db } from '../src/lib/firestore';
import { createSteamClient } from '../src/lib/steam/client';
import { paths } from '../src/lib/store/paths';

const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;
const base = 20_000_000 + Date.now() % 1_000_000;

describe.skipIf(!emulated)('player cache against Firestore', () => {
  it('persists counts and absent counters, hits cache, and refreshes at exact expiry without altering game or genre docs', async () => {
    const ids = [base + 1, base + 2];
    const steamId = '76561198000000199';
    const gameRef = db.doc(paths.userGame(steamId, ids[0]));
    const genreRef = db.doc(paths.app(ids[0]));
    await gameRef.set({ name: 'Keep game', playtime_forever: 75 });
    await genreRef.set({ genres: ['Keep genre'] });
    const fetch = vi.fn(async (input: string | URL | Request) => Number(new URL(String(input)).searchParams.get('appid')) === ids[0]
      ? Response.json({ response: { result: 1, player_count: 0 } })
      : Response.json({ response: { result: 42 } }, { status: 404 }));
    const client = createSteamClient({ fetch });
    const now = Date.now();
    expect(await getCurrentPlayers(ids, { now, client })).toMatchObject({ fetched: 2, unresolved: [], players: new Map([[ids[0], 0], [ids[1], null]]) });
    const record = (await db.doc(paths.appLive(ids[0])).get()).data()!;
    expect(record.fetchedAt).toBeInstanceOf(Timestamp);
    expect(record.expiresAt.toMillis()).toBe(now + APP_LIVE_TTL_MS);
    fetch.mockClear();
    expect((await getCurrentPlayers(ids, { now: now + APP_LIVE_TTL_MS - 1, client })).fetched).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect((await getCurrentPlayers(ids, { now: now + APP_LIVE_TTL_MS, client })).fetched).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await gameRef.get()).data()).toEqual({ name: 'Keep game', playtime_forever: 75 });
    expect((await genreRef.get()).data()).toEqual({ genres: ['Keep genre'] });
  });

  it('does not cache a transient Steam failure or return an expired count as current', async () => {
    const appid = base + 3;
    await db.doc(paths.appLive(appid)).set({ players: 99, fetchedAt: Timestamp.fromMillis(0), expiresAt: Timestamp.fromMillis(1) });
    const fetch = vi.fn(async () => Response.json({}, { status: 500 }));
    const result = await getCurrentPlayers([appid], { client: createSteamClient({ fetch, retries: 0 }) });
    expect(result).toEqual({ players: new Map(), fetched: 0, unresolved: [appid] });
    expect((await db.doc(paths.appLive(appid)).get()).data()!.expiresAt.toMillis()).toBe(1);
  });
});
