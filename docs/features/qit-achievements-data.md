# Achievements data

`src/lib/achievements/` holds each user's per-game achievement data and the incremental scan that fills it. It replaces the logic of `src/lib/achievement-cache.ts`, which is now a one-line re-export. `getCachedAchievementProgress(steamId, appid)` keeps its signature and behavior, so `GET /api/games/achievements` and its tests are unchanged.

| File | Contents |
|---|---|
| `model.ts` | Pure code: building a record from a Steam answer, TTLs, index summaries, roulette signals, scan order and cursor |
| `store.ts` | The single writer of `users/{id}/achievementProgress/{appid}` and of the index fields `ap`, `au` and `at`; `getCachedAchievementProgress` |
| `scan.ts` | `scanAchievements`, one batch of the incremental scan |
| `index.ts` | Re-exports all three |
| `src/app/api/achievements/scan/route.ts` | `POST /api/achievements/scan` |

Every Steam call goes through the shared client's `getPlayerAchievements` wrapper with `l=english`, so retries, the concurrency limit and the optional daily budget all apply.

## Stored record

`users/{steamId}/achievementProgress/{appid}` keeps its path. Version 2 of the document:

| Field | Meaning |
|---|---|
| `v` | `2`. A document without it was written by the old cache; it is treated as stale and refetched on first use. |
| `state` | `ok`, `no_stats` or `private` |
| `progress` | `{unlocked, total, percent}` for `ok`, otherwise `null`. Same shape as before. `percent` is floored, so a game is 100% only when every achievement is unlocked. |
| `locked` | The locked achievements in Steam's order: `{apiname, name?, description?}`. Name and description are the English text. Steam blanks the description of a hidden achievement, so it is left out. |
| `lockedTruncated` | `true` when more than 1,000 achievements were locked and the list was cut. Names are capped at 128 characters and descriptions at 256, which keeps a document well under Firestore's 1 MiB limit. |
| `lastUnlockAt` | Unix seconds of the newest unlock; `null` when nothing is unlocked |
| `fetchedAt` | ISO time of the Steam answer (the same field as before) |
| `expiresAt` | Firestore `Timestamp`; the record is refetched after it |

Unlocked achievements are counted but not listed. Readers use `readAchievementRecord(s)`, and `toAchievementSignals(record)` maps a record to the roulette `AchievementSignals` (`lockedRare` stays `null` until rarity is joined in by `qit-rare-challenge`).

## Freshness

| Answer | TTL | Why |
|---|---|---|
| `ok` below 100% | 24 h | the plan's value for games still in progress |
| `ok` at 100% | 30 d | a finished game only changes when the developer adds achievements |
| `no_stats` (HTTP 400 "Requested app has no stats", or no achievements) | 7 d | the plan's negative TTL; it is a property of the app |
| `private` (HTTP 403 "Profile is not public") | 1 h | see below |

The steam-client live check found accounts whose owned games are public but whose achievements answer 403 "Profile is not public". That is a privacy setting the user can change in a minute after QIT tells them about it, so a private answer is cached only briefly. It is still cached, so the picker does not call Steam for every pick. Any other failure (5xx, timeout, an HTML 403 from a key or edge block, throttling) caches nothing and throws, as before.

## Library index

Each stored answer patches the entry's achievement summary in `users/{id}/libIndex/*` with `patchLibIndex`. Existing entries only: this package never creates an entry, so it can never bring back a game the library sync removed.

| Answer | `ap` | `au` | `at` |
|---|---|---|---|
| `ok` | percent | unlocked | total |
| `no_stats` | removed | removed | `0`: known to have no achievements |
| `private` | removed | removed | removed: unknown |

A missing `at` means unknown, not zero. `achievementSignalsFromIndex(entry)` reads the summary without the per-game document (`lastUnlockAt` is then `null`).

## Scan

`POST /api/achievements/scan` with body `{ cursor?: string | null, limit?: 1..15 }`. It requires a session, a same-origin request and a per-user token bucket (20 calls, refilled one every 2 s). The response always has `Cache-Control: private, no-store`:

```json
{ "state": "running", "cursor": "a1....", "progress": { "done": 17, "total": 212 },
  "fetched": { "ok": 12, "noStats": 3, "private": 0, "failed": 0 }, "message": null }
```

| `state` | Client action |
|---|---|
| `running` | Call again with `cursor` |
| `complete` | The pass is finished (`cursor` is `null`) |
| `private` | Stop and show `message`, which tells the user to make Game details public. `cursor` is `null`. |
| `rate_limited` | Call again with `cursor` after `retryAfter` seconds. A `null` cursor here means start from the top. This state covers Steam throttling and an exhausted daily key budget. |

A malformed cursor or body gets a 400. A storage failure gets the shared 502 envelope.

For each call, the scan:

1. Reads the library: four index reads. Before the index is built for a user (the user has not resynced since `qit-library-model` landed), it reads the `appid`, playtime and stats fields of the per-game documents instead.
2. Orders the games. Games known to have achievements come first, then games where that is unknown. Within each group the order is most playtime first, then appid. A game is known to have achievements, or known not to, from the store metadata's achievements category when that is cached (`f` bits from `qit-app-metadata`: `known` is `1 << 0`, `achievements` is `1 << 6`), and otherwise from Steam's `has_community_visible_stats` (`s`, from `qit-library-model`). **Games known to have no achievements are left out of the scan entirely**, which is what keeps a first scan near the plan's estimate of one call per achievement game. The single-game route still fetches them on demand. Until both packages land, every game is "unknown" and the scan covers the whole library in playtime order.
3. Walks forward from the cursor and reads the stored records in groups of 30, at most 120 per call. It stops at 15 due games, meaning games whose record is missing, pre-v2 or expired. A fresh game costs one read and no Steam call.
4. Fetches the due games. The first one runs alone as a probe, so a private profile or a throttled key costs one call instead of five. The rest run five at a time. No new call starts after 15 s, so with the client's 25 s per-call deadline a request stays under the 60 s Hosting limit.
5. Stores every answer and patches the index in one batch and one index transaction. Fresh records whose index summary is missing or out of date are re-synced in the same patch without a Steam call. That covers records written before the user's index was built.
6. Moves the cursor past the longest run of settled games (fresh, stored or failed). Games skipped by a stop or by the time limit come first on the next call. A failed game is logged and not cached, and it is retried on the next pass.

The cursor is keyset-based (`[group, playtime, appid]`, base64url behind an `a1.` prefix), not an offset. A library resync between two calls therefore neither skips nor repeats more than the games whose playtime changed.

Decision D13: the UI runs this loop with a progress bar the first time an achievement mode is used. Running it again later is the incremental refresh, because only expired records cost Steam calls.

### Cost

- **Steam key calls:** one per due game. The first pass is about one call per achievement game once the hints exist, which is roughly 350 for a 1,000-game library (report section 7.1). After that, a daily pass refetches only in-progress games (24 h). Finished games cost one call a month and no-stats games one a week.
- **Firestore reads per call:** 4 index reads plus at most 120 record reads. A user without an index costs one read per owned game per call until their next sync.
- **Firestore writes per call:** at most 15 records plus one transaction on the touched index chunks.

## Compatibility notes

- `getAchievementProgress` in `src/lib/steam.ts` (lines 123 to 140) is no longer used by app code. It is left in place, still covered by `tests/security.test.ts`, because removing it would create adjacent-hunk merge conflicts with `qit-library-model`'s edits to `getSteamGames`. A later cleanup can delete it. `AchievementProgress` is still imported from there.
- The fixture in `tests/firestore.test.ts` ("returns fetched achievement progress when the cache write fails") now gives its two achievements `apiname`s. Real Steam answers always carry them, and the shared wrapper drops entries without one.
- The `f` bit values above duplicate `STORE_FLAG_BITS` from `qit-app-metadata`, which had not merged when this package was written. Once it merges, `achievementSupportHint` should import them instead.

## Tests

- `tests/qit-achievements-data.test.ts` (unit): record building, truncation and TTLs, index summaries and signals, stored-record parsing, scan order, hints and cursor, and the scan loop with mocked storage and Steam. The mocked scan tests cover batches, the read limit, private and throttled stops, failures, the time limit and index re-sync. The route tests cover auth, same-origin, validation and response shapes.
- `tests/qit-achievements-data.emulator.test.ts` (`npm run test:firestore`): the v2 record and index summary, migration of pre-v2 records, private and no-stats index states, a full two-call scan with a TTL-driven refresh, the per-game-document fallback with an early private stop, index re-sync without Steam calls, and an empty library.
- The existing achievement tests in `tests/firestore.test.ts`, `tests/routes.test.ts` and `tests/security.test.ts` pass unchanged, apart from the fixture note above.
