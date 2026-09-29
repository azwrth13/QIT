# Steam client

`src/lib/steam/` is the one HTTP path for new Steam calls. `src/lib/steam.ts` is unchanged: its exports stay as they are, and it imports nothing from `src/lib/steam/`, because `tests/library.test.mjs` loads it through Node type stripping. The new modules import `isSteamId`, `steamApiUrl` and `SteamApiError` from `steam.ts`, so the dependency points one way only. Existing routes keep using `steamJson` until their owning package moves them over.

| File | Contents |
|---|---|
| `client.ts` | `createSteamClient`, the shared `getSteamClient()` / `setSteamClient()`, `SteamClientError`, `classifySteamStatus`, `parseRetryAfter`, `createSemaphore` |
| `budget.ts` | optional daily budget for keyed calls: `createDailyBudget`, `memoryBudgetStore`, `firestoreBudgetStore` |
| `urls.ts` | `steamKeyedUrl`, `steamKeylessUrl`, `steamStoreUrl`, art URLs (`steamHeaderImageUrl`, `steamLibraryCapsuleUrl`, `steamIconUrl`, `steamStoreAssetUrl`) |
| `owned.ts` | `getOwnedGames`, `getRecentlyPlayedGames` (keyed) |
| `players.ts` | `getPlayerSummaries` (batches of 100), `getFriendList`, `resolveVanityUrl` (keyed) |
| `achievements.ts` | `getPlayerAchievements`, `getSchemaForGame` (keyed) |
| `rarity.ts` | `getGlobalAchievementPercentages` (keyless) |
| `charts.ts` | `getCurrentPlayers`, `getGamesByConcurrentPlayers`, `getMostPlayedGames` (keyless) |
| `store.ts` | `getStoreItems` (batched `GetItems`, 100 ids per call), `getAppDetails`, `getTagList` (keyless) |

Every wrapper takes an optional last `client` argument; tests pass one built with `createSteamClient({ fetch, sleep, now, random })`.

## Client behavior

Defaults are in `STEAM_CLIENT_DEFAULTS`:

- **Concurrency:** 5 requests in flight per client. The shared client is per server instance, so with `maxInstances: 2` up to 10 run at once overall. Waiters run in FIFO order.
- **Timeout:** 12 s per attempt, including reading the body. There is also a 25 s deadline for the whole call, retries and waits included, which keeps routes well under the 60 s Hosting limit.
- **Retry:** up to 2 retries on 408, 429, 500, 502, 503, 504 and network or timeout errors. The backoff is full-jitter exponential (400 ms base, 4 s cap). For 429 and 503 the client waits for the `Retry-After` time (seconds or an HTTP date) plus some jitter. If `Retry-After` is longer than 5 s, or a wait would run past the deadline, the call fails at once. The error then carries `retryAfterSeconds` so a route can pass it on.
- **Accepted statuses:** `request(url, { accept: [403] })` returns `{ status, data }` for those statuses instead of throwing. A 2xx answer whose body is not JSON counts as `unavailable`.
- **Errors:** every failure is a `SteamClientError`, which extends the existing `SteamApiError`, so current `instanceof` checks and `status` reads still work. `kind` is one of:

| kind | when |
|---|---|
| `private` | 401 or 403 (hidden profile, games or friends list; a bad key also ends up here) |
| `not_found` | 404 |
| `rate_limited` | 429 after the retries run out, or a `Retry-After` that is too long |
| `unavailable` | 5xx, 408, network error, timeout, deadline reached, or a 2xx that is not JSON |
| `invalid` | any other 4xx |
| `budget_exhausted` | the daily key budget is used up; Steam was not called |

  Error messages never contain URLs, keys or bodies, and the original network error is dropped because its cause can contain the URL. Log with `logServerError` only.

- **Keyed and keyless:** a keyed URL is one that carries `key`. `steamKeylessUrl` and `steamStoreUrl` never read `STEAM_API_KEY` and refuse a `key` parameter in any letter case. `steamKeyedUrl` / `steamKeylessUrl` accept only `/Interface/Method/vN/` paths, so a caller cannot change the host.
- `client.stats()` returns request, retry, keyed and keyless counters plus the current `active` and `waiting` counts.

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

- `getOwnedGames`: `{ state: 'private' }`, or `{ state: 'public', gameCount, games }`. An empty public library has `game_count: 0` and is public, not private. `include_played_free_games` is on by default. `playtime_2weeks` is 0 when Steam leaves it out. `rtime_last_played` is `null` when Steam leaves it out, and a 0 is kept as Steam sent it.
- `getPlayerAchievements`: `ok` / `no_stats` / `private`. A 400 or 403 counts as `no_stats` or `private` only when the body is Steam's own `playerstats.success: false`. Any other 4xx body throws, so a key or edge block is not cached as "private".
- `getCurrentPlayers`: returns `null` when Steam answers 404 with `result: 42` (the app has no counter).
- `getGlobalAchievementPercentages`: returns `null` on `403 {}` (the app has no stats). Steam sends each percent as a string, and it is parsed to a number.
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
- `GetGamesByConcurrentPlayers`: HTTP 200, `last_update` plus 100 ranks of `rank, appid, concurrent_in_game, peak_in_game`. `GetMostPlayedGames`: HTTP 200, `rollup_date` plus 100 ranks of `rank, appid, last_week_rank, peak_in_game`.
- `GetItems` with 620, 431960, 323180 and 228980: `success/type` values were 1/0 (game), 1/6 (software), 1/11 (soundtrack, `related_items.parent_appid` 620) and 15/none, where the hidden app comes back with `appid: 0`. A batch of 100 ids returned HTTP 200. Item keys seen: `item_type, id, success, visible, name, store_url_path, store_url_slug, appid, type, tagids, categories, reviews, tags, assets, release, best_purchase_option, is_free, related_items`.
- `GetTagList`: HTTP 200, 446 tags. `appdetails` 620: HTTP 200 with `genres` and `categories`. `appdetails` 620,730: HTTP 400.
- Calling the wrappers themselves (through the shared client, with no key in the environment) parsed all of the above. There were 9 requests, all keyless, and 0 retries.

### Keyed checklist (A.3 items 1 to 7): pending

These checks were not run. The key exists only in the Firebase secret store, and this package was built without access to it. Until someone runs them, the fields the report marks "unverified" stay unverified: `rtime_last_played`, the "total playtime private" behavior, the `l=english` achievement fields, schema icons and hidden descriptions, the summary fields for friends-only profiles, the private-profile shape of `GetRecentlyPlayedGames`, and the status code for a private friends list. The wrappers already accept each documented variant (field present or missing, 401 or 403). Whoever runs the keyed command above should paste its output here and correct report section 3 if any field differs.
