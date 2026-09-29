#!/usr/bin/env node
// Steam Web API shape check (report Appendix A.3 plus the keyless endpoints).
//
//   node scripts/steam-live-check.mjs --keyless
//   STEAM_API_KEY=... QIT_CHECK_PUBLIC_ID=... [other QIT_CHECK_* ids] node scripts/steam-live-check.mjs
//
// Prints Markdown with HTTP statuses, counts and field names only. It never prints the key,
// request URLs, Steam IDs, names or other profile values, so the output can be pasted into docs.
// Set the key in the shell for this one command; never commit it or paste it anywhere.

const API = 'https://api.steampowered.com';
const env = process.env;
const key = env.STEAM_API_KEY || '';
const keyless = process.argv.includes('--keyless');
const ids = {
  public: env.QIT_CHECK_PUBLIC_ID, // Game details and friends list public
  privateGames: env.QIT_CHECK_PRIVATE_ID, // Game details private
  hiddenPlaytime: env.QIT_CHECK_HIDDEN_PLAYTIME_ID, // "Always keep my total playtime private"
  friendsOnly: env.QIT_CHECK_FRIENDS_ONLY_ID, // profile visible to friends only
  privateFriends: env.QIT_CHECK_PRIVATE_FRIENDS_ID, // friends list private
};
const appid = env.QIT_CHECK_APPID || '620'; // a game the public account owns, with achievements
const noStatsAppid = env.QIT_CHECK_NOSTATS_APPID || '7';

const lines = [];
const out = line => lines.push(line);
const redact = text => (key ? String(text).split(key).join('[key]') : String(text));

async function get(path, params, { keyed = true, origin = API } = {}) {
  const url = new URL(path, origin);
  url.search = new URLSearchParams(keyed ? { ...params, key } : params).toString();
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, body, kind: body === null ? (text ? 'non-JSON' : 'empty') : 'JSON' };
  } catch (error) {
    return { status: 0, body: null, kind: `network error (${error?.name ?? 'Error'})` };
  }
}

const keysOf = objects => {
  const counts = new Map();
  for (const object of objects) for (const name of Object.keys(object ?? {})) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} (${count}/${objects.length})`).join(', ') || 'none';
};
const shape = result => `HTTP ${result.status}, ${result.kind}${result.body && typeof result.body === 'object' ? `, top-level keys: ${Object.keys(result.body).join(', ') || 'none'}` : ''}`;
const skip = (title, why) => { out(`### ${title}`); out(`- skipped: ${why}`); out(''); };

async function ownedGames() {
  const title = 'A.3.1 GetOwnedGames (public account)';
  if (!ids.public) return skip(title, 'QIT_CHECK_PUBLIC_ID not set');
  const result = await get('/IPlayerService/GetOwnedGames/v1/', { steamid: ids.public, include_appinfo: '1', include_played_free_games: '1' });
  const games = result.body?.response?.games ?? [];
  const has = field => games.filter(game => field in game).length;
  const neverPlayed = games.filter(game => !game.playtime_forever);
  out(`### ${title}`);
  out(`- ${shape(result)}; game_count present: ${typeof result.body?.response?.game_count === 'number'}; games: ${games.length}`);
  out(`- field presence: rtime_last_played ${has('rtime_last_played')}, playtime_2weeks ${has('playtime_2weeks')}, has_community_visible_stats ${has('has_community_visible_stats')}, playtime_forever ${has('playtime_forever')}, img_icon_url ${has('img_icon_url')}`);
  out(`- all game keys: ${keysOf(games)}`);
  out(`- never played (playtime_forever 0): ${neverPlayed.length}; their keys: ${keysOf(neverPlayed)}; rtime_last_played values: ${[...new Set(neverPlayed.map(game => game.rtime_last_played ?? 'absent'))].slice(0, 5).join(', ') || 'n/a'}`);
  out(`- played but rtime_last_played 0 or absent: ${games.filter(game => game.playtime_forever > 0 && !game.rtime_last_played).length}`);
  out('');
  if (!ids.privateGames) return skip('A.3.1b GetOwnedGames (private Game details)', 'QIT_CHECK_PRIVATE_ID not set');
  const hidden = await get('/IPlayerService/GetOwnedGames/v1/', { steamid: ids.privateGames, include_appinfo: '1', include_played_free_games: '1' });
  out('### A.3.1b GetOwnedGames (private Game details)');
  out(`- ${shape(hidden)}; response keys: ${Object.keys(hidden.body?.response ?? {}).join(', ') || 'none'}`);
  out('');
}

async function hiddenPlaytime() {
  const title = 'A.3.2 GetOwnedGames (total playtime kept private)';
  if (!ids.hiddenPlaytime) return skip(title, 'QIT_CHECK_HIDDEN_PLAYTIME_ID not set');
  const result = await get('/IPlayerService/GetOwnedGames/v1/', { steamid: ids.hiddenPlaytime, include_appinfo: '1', include_played_free_games: '1' });
  const games = result.body?.response?.games ?? [];
  out(`### ${title}`);
  out(`- ${shape(result)}; games: ${games.length}; with playtime_forever > 0: ${games.filter(game => game.playtime_forever > 0).length}; with rtime_last_played > 0: ${games.filter(game => game.rtime_last_played > 0).length}`);
  out(`- all game keys: ${keysOf(games)}`);
  out('');
}

async function playerAchievements() {
  const title = 'A.3.3 GetPlayerAchievements';
  if (!ids.public) return skip(title, 'QIT_CHECK_PUBLIC_ID not set');
  const result = await get('/ISteamUserStats/GetPlayerAchievements/v1/', { steamid: ids.public, appid, l: 'english' });
  const achievements = result.body?.playerstats?.achievements ?? [];
  out(`### ${title}`);
  out(`- app ${appid}: ${shape(result)}; playerstats keys: ${Object.keys(result.body?.playerstats ?? {}).join(', ') || 'none'}; achievements: ${achievements.length}`);
  out(`- achievement keys: ${keysOf(achievements)}`);
  out(`- blank description: ${achievements.filter(a => !a.description).length}; locked with unlocktime 0: ${achievements.filter(a => a.achieved === 0 && a.unlocktime === 0).length}`);
  const noStats = await get('/ISteamUserStats/GetPlayerAchievements/v1/', { steamid: ids.public, appid: noStatsAppid, l: 'english' });
  out(`- app ${noStatsAppid} (no stats): ${shape(noStats)}; success: ${noStats.body?.playerstats?.success}; error: ${noStats.body?.playerstats?.error ?? 'n/a'}`);
  if (ids.privateGames) {
    const hidden = await get('/ISteamUserStats/GetPlayerAchievements/v1/', { steamid: ids.privateGames, appid, l: 'english' });
    out(`- private Game details: ${shape(hidden)}; success: ${hidden.body?.playerstats?.success}; error: ${hidden.body?.playerstats?.error ?? 'n/a'}`);
  }
  out('');
}

async function schema() {
  const title = 'A.3.4 GetSchemaForGame';
  if (!key) return skip(title, 'STEAM_API_KEY not set');
  const result = await get('/ISteamUserStats/GetSchemaForGame/v2/', { appid, l: 'english' });
  const achievements = result.body?.game?.availableGameStats?.achievements ?? [];
  const hidden = achievements.filter(a => a.hidden === 1);
  out(`### ${title}`);
  out(`- app ${appid}: ${shape(result)}; game keys: ${Object.keys(result.body?.game ?? {}).join(', ') || 'none'}; achievements: ${achievements.length}`);
  out(`- achievement keys: ${keysOf(achievements)}`);
  out(`- hidden: ${hidden.length}; hidden with a description: ${hidden.filter(a => a.description).length}; icon URLs absolute: ${achievements.every(a => /^https:\/\//.test(a.icon ?? ''))}`);
  const none = await get('/ISteamUserStats/GetSchemaForGame/v2/', { appid: noStatsAppid, l: 'english' });
  out(`- app ${noStatsAppid} (no stats): ${shape(none)}; game keys: ${Object.keys(none.body?.game ?? {}).join(', ') || 'none'}`);
  out('');
}

async function summaries() {
  const title = 'A.3.5 GetPlayerSummaries (public vs friends-only)';
  const targets = [['public', ids.public], ['friends-only', ids.friendsOnly], ['private Game details', ids.privateGames]].filter(([, id]) => id);
  if (!targets.length || !key) return skip(title, 'no QIT_CHECK_* ids or key set');
  out(`### ${title}`);
  for (const [label, id] of targets) {
    const result = await get('/ISteamUser/GetPlayerSummaries/v2/', { steamids: id });
    const player = result.body?.response?.players?.[0];
    out(`- ${label}: ${shape(result)}; communityvisibilitystate ${player?.communityvisibilitystate ?? 'absent'}; personastate ${'personastate' in (player ?? {}) ? 'present' : 'absent'}; gameextrainfo ${'gameextrainfo' in (player ?? {}) ? 'present' : 'absent (not in game or hidden)'}; lastlogoff ${'lastlogoff' in (player ?? {}) ? 'present' : 'absent'}`);
    out(`  - keys: ${Object.keys(player ?? {}).join(', ') || 'none'}`);
  }
  out('');
}

async function recentlyPlayed() {
  const title = 'A.3.6 GetRecentlyPlayedGames';
  if (!ids.public) return skip(title, 'QIT_CHECK_PUBLIC_ID not set');
  const result = await get('/IPlayerService/GetRecentlyPlayedGames/v1/', { steamid: ids.public });
  out(`### ${title}`);
  out(`- public: ${shape(result)}; response keys: ${Object.keys(result.body?.response ?? {}).join(', ') || 'none'}; game keys: ${keysOf(result.body?.response?.games ?? [])}`);
  if (ids.privateGames) {
    const hidden = await get('/IPlayerService/GetRecentlyPlayedGames/v1/', { steamid: ids.privateGames });
    out(`- private Game details: ${shape(hidden)}; response keys: ${Object.keys(hidden.body?.response ?? {}).join(', ') || 'none'}`);
  }
  out('');
}

async function friendList() {
  const title = 'A.3.7 GetFriendList (private friends list)';
  if (!ids.privateFriends) return skip(title, 'QIT_CHECK_PRIVATE_FRIENDS_ID not set');
  const result = await get('/ISteamUser/GetFriendList/v1/', { steamid: ids.privateFriends, relationship: 'friend' });
  out(`### ${title}`);
  out(`- ${shape(result)}`);
  if (ids.public) {
    const open = await get('/ISteamUser/GetFriendList/v1/', { steamid: ids.public, relationship: 'friend' });
    out(`- public list: ${shape(open)}; friend keys: ${keysOf(open.body?.friendslist?.friends ?? [])}`);
  }
  out('');
}

async function keylessChecks() {
  out('### Keyless endpoints');
  const rarity = await get('/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/', { gameid: '620' }, { keyed: false });
  const list = rarity.body?.achievementpercentages?.achievements ?? [];
  out(`- GetGlobalAchievementPercentagesForApp 620: ${shape(rarity)}; achievements ${list.length}; percent types: ${[...new Set(list.map(a => typeof a.percent))].join(', ')}`);
  out(`- GetGlobalAchievementPercentagesForApp 7: ${shape(await get('/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/', { gameid: '7' }, { keyed: false }))}`);
  for (const id of ['730', '1']) {
    const players = await get('/ISteamUserStats/GetNumberOfCurrentPlayers/v1/', { appid: id }, { keyed: false });
    out(`- GetNumberOfCurrentPlayers ${id}: ${shape(players)}; response keys: ${Object.keys(players.body?.response ?? {}).join(', ')}; result: ${players.body?.response?.result}`);
  }
  const chart = await get('/ISteamChartsService/GetGamesByConcurrentPlayers/v1/', {}, { keyed: false });
  out(`- GetGamesByConcurrentPlayers: ${shape(chart)}; response keys: ${Object.keys(chart.body?.response ?? {}).join(', ')}; ranks ${chart.body?.response?.ranks?.length ?? 0}; rank keys: ${Object.keys(chart.body?.response?.ranks?.[0] ?? {}).join(', ')}`);
  const input = { ids: [620, 431960, 323180, 228980].map(id => ({ appid: id })), context: { language: 'english', country_code: 'US' },
    data_request: { include_assets: true, include_release: true, include_tag_count: 20, include_reviews: true } };
  const items = await get('/IStoreBrowseService/GetItems/v1/', { input_json: JSON.stringify(input) }, { keyed: false });
  const storeItems = items.body?.response?.store_items ?? [];
  out(`- GetItems: ${shape(items)}; per item (id: success/type/appid): ${storeItems.map(item => `${item.id}: ${item.success}/${item.type ?? '-'}/${item.appid}`).join(', ')}`);
  out(`  - item keys: ${keysOf(storeItems)}`);
  const big = { ...input, ids: Array.from({ length: 100 }, (_, i) => ({ appid: 10 + i * 10 })) };
  out(`- GetItems with 100 ids: ${shape(await get('/IStoreBrowseService/GetItems/v1/', { input_json: JSON.stringify(big) }, { keyed: false }))}`);
  const one = await get('/api/appdetails', { appids: '620', cc: 'us' }, { keyed: false, origin: 'https://store.steampowered.com' });
  out(`- appdetails 620: ${shape(one)}; success ${one.body?.['620']?.success}; has genres ${Array.isArray(one.body?.['620']?.data?.genres)}; has categories ${Array.isArray(one.body?.['620']?.data?.categories)}`);
  out(`- appdetails 620,730: ${shape(await get('/api/appdetails', { appids: '620,730', cc: 'us' }, { keyed: false, origin: 'https://store.steampowered.com' }))}`);
  out('');
}

out(`## Steam live check, ${new Date().toISOString().slice(0, 10)}`);
out('');
await keylessChecks();
if (keyless) {
  out('Keyed checks not run (--keyless).');
} else if (!key) {
  out('Keyed checks not run: STEAM_API_KEY is not set.');
} else {
  for (const check of [ownedGames, hiddenPlaytime, playerAchievements, schema, summaries, recentlyPlayed, friendList]) await check();
}
console.log(redact(lines.join('\n')));
