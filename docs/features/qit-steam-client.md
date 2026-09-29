# Steam client

`src/lib/steam/` is the one HTTP path for new Steam calls. `src/lib/steam.ts` is unchanged: its exports stay as they are, and it imports nothing from `src/lib/steam/`, because `tests/library.test.mjs` loads it through Node type stripping. The new modules import `isSteamId`, `steamApiUrl` and `SteamApiError` from `steam.ts`, so the dependency points one way only. Existing routes keep using `steamJson` until their owning package moves them over.

| File | Contents |
|---|---|
| `client.ts` | `createSteamClient`, the shared `getSteamClient()` / `setSteamClient()`, `SteamClientError`, `classifySteamStatus`, `parseRetryAfter`, `createSemaphore` |
| `budget.ts` | optional daily budget for keyed calls: `createDailyBudget`, `memoryBudgetStore`, `firestoreBudgetStore` |
| `urls.ts` | `steamKeyedUrl`, `steamKeylessUrl`, `steamStoreUrl`, art URLs (`steamHeaderImageUrl`, `steamLibraryCapsuleUrl`, and `steamIconUrl` as the fallback) |
| `owned.ts` | `getOwnedGames`, `getRecentlyPlayedGames` (keyed) |
| `players.ts` | `getPlayerSummaries` (batches of 100), `getFriendList`, `resolveVanityUrl` (keyed) |
| `achievements.ts` | `getPlayerAchievements`, `getSchemaForGame` (keyed) |
| `rarity.ts` | `getGlobalAchievementPercentages` (keyless) |
| `charts.ts` | `getCurrentPlayers`, `getGamesByConcurrentPlayers` (keyless) |
| `store.ts` | `getStoreItems` (batched `GetItems`, 100 ids per call), `getAppDetails` (keyless) |

Every wrapper takes an optional last `client` argument; tests pass one built with `createSteamClient({ fetch, sleep, now, random })`.

## Client behavior

Defaults are in `STEAM_CLIENT_DEFAULTS`:

- **Concurrency:** 5 requests in flight per client. The shared client is per server instance, so with `maxInstances: 2` up to 10 run at once overall. Waiters run in FIFO order.
- **Timeout:** 12 s per attempt, including reading the body. There is also a 25 s deadline for the whole call, retries, waits and time queued for a concurrency slot included, which keeps routes well under the 60 s Hosting limit.
- **Retry:** up to 2 retries on 408, 429, 500, 502, 503, 504 and network or timeout errors. The backoff is full-jitter exponential (400 ms base, 4 s cap). For 429 and 503 the client waits for the `Retry-After` time (seconds or an HTTP date) plus some jitter. If `Retry-After` is longer than 5 s, or a wait would run past the deadline, the call fails at once. The error then carries `retryAfterSeconds` so a route can pass it on.
- **Accepted statuses:** `request(url, { accept: [403] })` returns `{ status, data }` for those statuses instead of throwing. A 2xx answer whose body is not JSON counts as `unavailable`.
- **Errors:** every failure is a `SteamClientError`, which extends the existing `SteamApiError`, so current `instanceof` checks and `status` reads still work. `kind` is one of:

| kind | when |
|---|---|
| `private` | never thrown for a status. A 401 or 403 is never thrown as `private`, because a bad or blocked key answers with an HTML 401 or 403; wrappers return a private state only after checking Steam's JSON body |
| `not_found` | 404 |
| `rate_limited` | 429 after the retries run out, or a `Retry-After` that is too long |
| `unavailable` | 5xx, 408, 401, 403, any other 4xx, network error, timeout, deadline reached, or a 2xx that is not JSON |
| `budget_exhausted` | the daily key budget is used up; Steam was not called |

  Error messages never contain URLs, keys or bodies, and the original network error is dropped because its cause can contain the URL. Log with `logServerError` only.

- **Keyed and keyless:** a keyed URL is one that carries `key`. `steamKeylessUrl` and `steamStoreUrl` never read `STEAM_API_KEY` and refuse a `key` parameter in any letter case. `steamKeyedUrl` / `steamKeylessUrl` accept only `/Interface/Method/vN/` paths, so a caller cannot change the host.

## Daily budget (optional)

The Steam Web API terms allow 100,000 key calls per day. The client is created without a budget. To enforce one across instances, attach a Firestore-backed budget at startup:

```ts
setSteamClient(createSteamClient({
  budget: createDailyBudget({ store: firestoreBudgetStore(day => db.doc(/* path from src/lib/store */)) }),
}));
```

- Only keyed attempts spend budget, one unit per attempt, so retries count too. Keyless calls never touch it.
- Each instance reserves 25 calls at a time in one Firestore transaction (`{ used, day, updatedAt, expiresAt }`, one document per UTC day). The total across instances therefore never goes over the limit, and the cost is one transaction per 25 calls. The default limit is 90,000, which leaves headroom for manual checks.
- When the budget runs out, keyed calls throw `budget_exhausted` without calling Steam, and callers should serve cached data. If the store cannot be reached, the budget fails open, so a Firestore outage does not also take Steam calls down.
- `firestoreBudgetStore` takes a document reference factory, so the collection path stays with `qit-store-layer`. `expiresAt` is a real `Date` (stored as a Firestore Timestamp), so a TTL policy can clean old days up.

## Wrapper return shapes

These follow the plan's rule that unknown is its own state and never zero:

- `getOwnedGames`: `{ state: 'private' }`, or `{ state: 'public', gameCount, games }`. Private is only Steam's 200 answer with an empty `response`; any 403 throws, because a bad or blocked key answers with an HTML 403. An empty public library has `game_count: 0` and is public, not private. `include_appinfo=1` and `include_played_free_games=1` are always sent. `playtime_2weeks` is 0 when Steam leaves it out. `rtime_last_played` is `null` when Steam leaves it out, and a 0 is kept as Steam sent it.
- `getPlayerAchievements`: `ok` / `no_stats` / `private`. A 400 or 403 counts as `no_stats` or `private` only when the body is Steam's own `playerstats.success: false`. Any other 4xx body throws, so a key or edge block is not cached as "private".
- `getRecentlyPlayedGames` and `getFriendList`: a 403 (or, for `getFriendList`, a 401) whose body is not JSON (Steam's key-block page) throws `unavailable`. `getRecentlyPlayedGames` is private on a JSON 403 or a `response` without `total_count`; `getFriendList` is private on a JSON 401, a JSON 403, or a body without `friendslist`.
- `getCurrentPlayers`: returns `null` when Steam answers 404 with `result: 42` (the app has no counter).
- `getGlobalAchievementPercentages`: returns `null` on `403 {}` (the app has no stats). A 403 whose body is not JSON (an IP or edge block) throws `unavailable`. Steam sends each percent as a string, and it is parsed to a number.
- `getStoreItems`: returns a `Map` holding every requested appid. The value is `null` when Steam reports `success: 15` (hidden or delisted app). Items are matched by `id`, because hidden apps come back with `appid: 0`.

## Live verification

`scripts/steam-live-check.mjs` runs the report's Appendix A.3 checklist plus the keyless endpoints. It prints Markdown containing only HTTP statuses, counts and field names. It never prints the key, request URLs, Steam IDs or profile values, and it replaces any occurrence of the key in its output.

```sh
node scripts/steam-live-check.mjs --keyless
# Keyed run: set the key in the shell for this one command only; never commit or paste it.
STEAM_API_KEY=... QIT_CHECK_PUBLIC_ID=<17 digits> QIT_CHECK_PRIVATE_ID=... QIT_CHECK_HIDDEN_PLAYTIME_ID=... \
  QIT_CHECK_FRIENDS_ONLY_ID=... QIT_CHECK_PRIVATE_FRIENDS_ID=... node scripts/steam-live-check.mjs
```

Optional: `QIT_CHECK_APPID` (default 620, a game the public account owns that has achievements) and `QIT_CHECK_NOSTATS_APPID` (default 7). A check whose account is not set is reported as skipped.

### Keyless results (2026-09-29)

They match report section 3; nothing needs correcting.

- `GetGlobalAchievementPercentagesForApp` 620: HTTP 200, 51 achievements, `percent` is a string. App 7: HTTP 403, body `{}`.
- `GetNumberOfCurrentPlayers` 730: HTTP 200, `{player_count, result: 1}`. App 1: HTTP 404, `{result: 42}`.
- `GetGamesByConcurrentPlayers`: HTTP 200, `last_update` plus 100 ranks of `rank, appid, concurrent_in_game, peak_in_game`.
- `GetItems` with 620, 431960, 323180 and 228980: `success/type` values were 1/0 (game), 1/6 (software), 1/11 (soundtrack, `related_items.parent_appid` 620) and 15/none, where the hidden app comes back with `appid: 0`. A batch of 100 ids returned HTTP 200. Item keys seen: `item_type, id, success, visible, name, store_url_path, store_url_slug, appid, type, tagids, categories, reviews, tags, assets, release, best_purchase_option, is_free, related_items`.
- `appdetails` 620: HTTP 200 with `genres` and `categories`. `appdetails` 620,730: HTTP 400, non-JSON.
- Calling the wrappers themselves (through the shared client, with no key in the environment) parsed all of the above, all keyless, with 0 retries.
- The keyless results were re-run on 2026-09-29 together with the keyed run below and were unchanged.

### Keyed checklist (A.3 items 1 to 7), 2026-09-29

The test accounts were the Steam accounts already stored in QIT's own Firestore (`users`, read-only). There were 3 of them, and no friend IDs are cached there. The key was read from the Firebase secret store straight into the environment of the one command that needed it, and the Steam IDs were passed only through that command's environment. Neither the key nor any Steam ID was printed, logged or saved. Keyed calls sorted the 3 accounts by real privacy state:

- Account A: `GetOwnedGames` returns 87 games with extra fields (per-platform playtime, `playtime_disconnected`, `rtime_last_played`), but `GetPlayerAchievements` answers 403 "Profile is not public". The friends list is public.
- Account B: owned games (241), achievements and recent games are all public. The friends list is private.
- Account C: `GetOwnedGames` returns 51 games, but `GetPlayerAchievements` answers 403 "Profile is not public".
- All three have `communityvisibilitystate` 3 (public profile). None has every `playtime_forever` at 0, and none gets an empty `GetOwnedGames` response.

| Item | Result |
|---|---|
| 1. `GetOwnedGames` fields and never-played games | run (accounts A and B) |
| 1b. `GetOwnedGames` with private Game details | skipped: no stored account has Game details private to `GetOwnedGames` (all 3 return their games) |
| 2. `GetOwnedGames` with "total playtime private" | skipped: no stored account has hidden total playtime (every account has some `playtime_forever` above 0) |
| 3. `GetPlayerAchievements` fields, 400 and 403 shapes | run (B for fields, C for 403) |
| 4. `GetSchemaForGame` with `l=english` | run (no account needed) |
| 5. `GetPlayerSummaries` public vs friends-only | public run (B and C); friends-only skipped: no stored account has a friends-only or private profile |
| 6. `GetRecentlyPlayedGames` shape and private 403 | shape run (B and C); the private 403 was not seen, because every stored account answers 200 |
| 7. `GetFriendList` for a private list | run (B); public list run (A) |

1. `GetOwnedGames` (`include_appinfo=1`, `include_played_free_games=1`), HTTP 200:
   - Account B (241 games): every game has `appid, name, playtime_forever, img_icon_url`. `has_community_visible_stats` is on 203 games, `playtime_2weeks` only on the 2 games played in the last two weeks, and `content_descriptorids` and `has_leaderboards` on some. **`rtime_last_played` is absent on every game**, including the 154 that were played. A never-played game (87 of them) has `playtime_forever: 0` and no `playtime_2weeks`.
   - Account A (87 games): `rtime_last_played` is on all 87 games, plus `playtime_windows_forever`, `playtime_mac_forever`, `playtime_linux_forever`, `playtime_deck_forever` and `playtime_disconnected`. The 6 never-played games have `rtime_last_played: 0`. Every played game has a non-zero value.
   - Result: `rtime_last_played` is not returned for every account; it came back only for the account that also gets the extra playtime fields. The wrapper maps an absent value to `null` (unknown), and a 0 on a never-played game is kept as 0.
3. `GetPlayerAchievements` (`l=english`):
   - Account B, app 730: HTTP 200, `playerstats` has `steamID, gameName, achievements, success: true`. Each achievement has `apiname, achieved, unlocktime, name, description`. The hidden achievement's `description` is an empty string here, while the schema leaves the field out.
   - App 7 (no stats): HTTP 400, JSON `{"playerstats": {"success": false, "error": "Requested app has no stats"}}`, which becomes `no_stats`.
   - Accounts A and C: HTTP 403, JSON `{"playerstats": {"success": false, "error": "Profile is not public"}}`, which becomes `private`. Both accounts still get their games back from `GetOwnedGames` and `GetRecentlyPlayedGames`, so achievements can be private while owned games are visible.
4. `GetSchemaForGame` (`l=english`):
   - App 620: 51 achievements with `name, defaultvalue, displayName, hidden, description, icon, icongray`; none hidden.
   - App 1245620: 42 achievements, 36 hidden, and none of the hidden ones has a `description` field. App 730: 1 hidden achievement, also without `description`.
   - `icon` and `icongray` are always present and are absolute `https://` URLs. App 7: HTTP 200 with `game: {}`, so the wrapper returns an empty list.
5. `GetPlayerSummaries`, public profiles (B and C): HTTP 200 with `communityvisibilitystate: 3`. `personastate`, `lastlogoff`, `profilestate`, `commentpermission`, `timecreated`, `personastateflags`, `primaryclanid` and `loccountrycode` are present; `realname` appears only when set. `gameextrainfo` is absent (neither was in a game).
6. `GetRecentlyPlayedGames`: HTTP 200, `response` has `total_count, games`. Each game has `appid, name, playtime_2weeks, playtime_forever, img_icon_url`, plus per-platform playtime for account A. Account C also answers 200 with games, even though its achievements are private.
7. `GetFriendList`: a private list is **HTTP 401 with a JSON body `{}`**, not an HTML page, and no 403 was seen. A public list is HTTP 200 with `friendslist.friends` of `steamid, relationship, friend_since`.

Bad key (checked with a made-up key, no account): HTTP 403, `text/html`, body starting "Forbidden ... Access is denied. Retrying will not help. Please verify your key= parameter". `GetOwnedGames` instead answers HTTP 401, `text/html`, "Unauthorized ... Please verify your key= parameter". So a 401 or 403 alone cannot mean "private". `classifySteamStatus` maps a thrown 401 or 403 to `unavailable`. `getOwnedGames` throws on any 401 or 403. `getRecentlyPlayedGames`, `getFriendList` and `getGlobalAchievementPercentages` throw on a non-JSON 403, and `getPlayerAchievements` throws on any 400 or 403 that lacks `success: false`.

None of the real responses disproved a wrapper's parsing. The HTML 403 on a bad key is why the thrown 403 kind changed.

Corrections to the plan's Steam API table:

- `GetOwnedGames`: `rtime_last_played` is not returned for every account. For some public accounts it is absent from every game, so an absent value is unknown, never "never played". Only a present 0 on a game with `playtime_forever: 0` means never played. Per-platform playtime fields and `playtime_disconnected` exist but were not returned for every account.
- `GetOwnedGames` vs `GetPlayerAchievements`: getting games back does not mean achievements are visible. Two accounts returned their games but got 403 "Profile is not public" from `GetPlayerAchievements`.
- `GetFriendList`: a private list is 401 with a JSON `{}` body; no 403 was seen.
- `GetPlayerAchievements`: the 400 and 403 bodies are `playerstats: { success: false, error }` with the messages above. With `l=english`, a hidden achievement's `description` is an empty string.
- `GetSchemaForGame`: an app without stats answers HTTP 200 with an empty `game` object, not an error status. Hidden achievements have no `description` field at all.
- Keyed endpoints: a wrong or blocked key answers with an HTML 403 (an HTML 401 on `GetOwnedGames`), the same status the plan lists for private data. A 403 therefore counts as private only when it carries a JSON body from Steam, never from the status alone.
- Still unverified, because no stored account has the setting: the `GetOwnedGames` private-Game-details shape, the hidden-total-playtime behavior, friends-only summary fields, and the private 403 from `GetRecentlyPlayedGames`.
