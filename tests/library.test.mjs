import test from 'node:test';
import assert from 'node:assert/strict';
import { pickGame } from '../src/lib/games.ts';
import { getPublicLibrary, getPublicLibraryResponse } from '../src/lib/steam.ts';

test('picker never falls back to full library when filters have no matches', () => {
  const allGames = [{ appid: 1, name: 'One' }];
  const filtered = allGames.filter(game => game.name.includes('missing'));
  assert.equal(pickGame(filtered, () => 0), null);
  assert.equal(pickGame(allGames, () => 0)?.appid, 1);
});

test('private Steam profile does not request or reveal owned games', async () => {
  const previousKey = process.env.STEAM_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.STEAM_API_KEY = 'test-key';
  let gameRequests = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('GetOwnedGames')) gameRequests++;
    return new Response(JSON.stringify({ response: { players: [{ steamid: '76561198000000000', personaname: 'Private', profileurl: 'https://steamcommunity.com/profiles/76561198000000000', avatarfull: '', avatarmedium: '', communityvisibilitystate: 1 }] } }), { status: 200 });
  };
  try {
    const library = await getPublicLibrary('76561198000000000');
    assert.equal(library.state, 'private');
    assert.deepEqual(library.games, []);
    assert.equal(gameRequests, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STEAM_API_KEY;
    else process.env.STEAM_API_KEY = previousKey;
  }
});

test('public profile with zero owned games is empty rather than private', async () => {
  const previousKey = process.env.STEAM_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.STEAM_API_KEY = 'test-key';
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('GetOwnedGames')
    ? { response: { game_count: 0 } }
    : { response: { players: [{ steamid: '76561198000000000', personaname: 'Empty', profileurl: '', avatarfull: '', avatarmedium: '', communityvisibilitystate: 3 }] } }), { status: 200 });
  try {
    const library = await getPublicLibrary('76561198000000000');
    assert.equal(library.state, 'public');
    assert.deepEqual(library.games, []);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STEAM_API_KEY;
    else process.env.STEAM_API_KEY = previousKey;
  }
});

test('public library route validates ids, caches per Steam ID, and rate limits per IP', async () => {
  const previousKey = process.env.STEAM_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.STEAM_API_KEY = 'test-key';
  let steamRequests = 0;
  globalThis.fetch = async () => {
    steamRequests++;
    return new Response(JSON.stringify({ response: { players: [] } }), { status: 200 });
  };
  try {
    const invalid = await getPublicLibraryResponse('123', '10.0.0.1', 0);
    assert.equal(invalid.status, 400);
    assert.equal(steamRequests, 0);

    const unknown = await getPublicLibraryResponse('76561198000000001', '10.0.0.1', 0);
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.message, /not found/);
    assert.equal(steamRequests, 1);

    for (let i = 1; i < 20; i++) await getPublicLibraryResponse('76561198000000001', '10.0.0.1', 1000);
    assert.equal(steamRequests, 1);
    const limited = await getPublicLibraryResponse('76561198000000001', '10.0.0.1', 1000);
    assert.equal(limited.status, 429);
    assert.equal(limited.retryAfter, 59);
    assert.equal((await getPublicLibraryResponse('76561198000000001', '10.0.0.2', 1000)).status, 404);

    await getPublicLibraryResponse('76561198000000001', '10.0.0.1', 5 * 60 * 1000 + 1);
    assert.equal(steamRequests, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STEAM_API_KEY;
    else process.env.STEAM_API_KEY = previousKey;
  }
});
