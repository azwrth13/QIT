# Library model

The library sync now writes the compact library index (`users/{steamId}/libIndex/*`, see `qit-store-layer.md`) next to the per-game documents, and every library read goes through the index. A library load costs four reads, however big the library is. It used to cost about 2N reads plus up to 40 Store calls.

| File | Contents |
|---|---|
| `src/lib/library/model.ts` | Pure logic: conversions between Steam games, `Game`, index entries and per-game documents; the sync diff (`planSync`); `detectPlaytimeHidden`; `librarySignals` for the roulette `LibrarySignals`. |
| `src/lib/library/index.ts` | Firestore: `getLibrary`, `getLibraryGames`, `ownsGames`, `syncLibrary`. It also re-exports `model.ts`. |
| `src/lib/library-data.ts` | The existing module the routes import. `getStoredGames`, `ownsGames` and `syncLibrary` now delegate to `src/lib/library`, and its export list is unchanged, so the `tests/routes.test.ts` mock still matches. |

## Steam fields

`syncLibrary` calls the steam-client wrapper `getOwnedGames`, which always sends `include_played_free_games=1`. `getSteamGames` in `steam.ts`, used for public and friend libraries, now also sends `include_played_free_games` and keeps the same fields. `Game` (`src/lib/games.ts`) gains:

| Field | Meaning |
|---|---|
| `playtime_2weeks` | Minutes in the last two weeks. Steam sends it only for recently played games, so a missing value is 0. |
| `rtime_last_played` | Unix seconds, or `null` when unknown. `lastPlayedAt()` normalizes it: a time above 0 is kept, and 0 means "never played" only when the game also has 0 playtime. A missing value, or 0 on a game that has playtime, is `null`. The steam-client live check found accounts where Steam leaves the field out of every game, so a missing value can never mean "never". |
| `has_community_visible_stats` | Steam's stats flag, a cheap hint for which games may have achievements. |

## Storage

- **Index entries** get library-model's fields `n, i, p, w, r, s`. `s` is new (`has_community_visible_stats` as 1 or 0), and was added to `LibIndexEntry` and the converter. `r` is written only when it is known: a stored 0 always means never played, and a missing `r` means unknown. The sync patches only these fields with merge writes (`patchLibIndex(..., { create: true })`), and it sends `null` to delete an `r` that has become unknown. It never rewrites a whole entry, so the `f` field from app-metadata and the `ap/au/at` fields from achievements-data survive every sync. That avoids the overwrite trap described in plan section 1.4, which only affects the per-game documents.
- **Per-game documents** (`users/{id}/games/{appid}`) are still written as full records with plain `set`: `{appid, name, img_icon_url, playtime_forever, playtime_2weeks, rtime_last_played, has_community_visible_stats}`. `syncLibrary` is their only writer, and nothing else may store data there. They are kept until a later cleanup and are no longer read once the index is built.
- **The user document** gets `flags.playtimeHidden`, written as a nested merge so other flags such as `friendsListPublic` are kept.

### Sync order

1. `getOwnedGames`. A private library returns `null` and writes nothing.
2. Read the index (four reads). If it has never been built, list the legacy per-game document ids instead (one read per document, once per user).
3. `planSync` diffs Steam's games against the index. Only new or changed games are written, and games that are no longer owned are removed.
4. Commit the per-game document writes and deletes (450 per batch), then the index patch (one batch, at most four chunk writes), then remove entries for games that are no longer owned.
5. Write the profile, `lastSyncedAt` and `flags.playtimeHidden`.

The index is written last. If a sync is interrupted, the index still holds the old state, so the next sync sees the same differences and writes them again. Every step can safely run twice. A sync with no changes writes nothing except the user document.

## Reads

- `getLibrary(steamId)` returns `{ games, source, playtimeHidden, lastSyncedAt }` for five reads: the user document plus the four chunks. Games are sorted by appid.
- `getStoredGames` (used by `GET /api/games`) returns the games only, for four reads. It no longer fills genres. The library page already loads missing genres through `POST /api/games/genres` in batches of 40, and that route is unchanged. `syncLibrary` no longer attaches cached genres either, which saves N `apps` reads per sync.
- `ownsGames` checks the index, for four reads. The genres route used to spend up to 40 reads here.

### Existing users

Users who synced before this change have per-game documents but no index. Until their next sync, `getStoredGames`, `getLibrary` (which reports `source: 'legacy'`) and `ownsGames` read the per-game documents, so the library never looks empty in the meantime. The next sync (on sign-in, or with the refresh button) builds the index from Steam, fills in the new fields, and deletes documents for games that are no longer owned. From then on the index is the read path. No migration script is needed.

## Playtime hidden

Steam lets a user hide their total playtime while Game details stay public, and `GetOwnedGames` then reports 0 minutes for every game. The steam-client live check could not observe this setting, because no available account had it. `detectPlaytimeHidden` flags a library when every game has 0 `playtime_forever` and 0 `playtime_2weeks`, and either:

- the library has at least `PLAYTIME_HIDDEN_MIN_GAMES` (5) games, so "never played anything" is implausible, or
- Steam still reports a last-played time on a game that shows 0 minutes.

The result is stored as `flags.playtimeHidden`, returned by `getLibrary` and included in the `POST /api/games/sync` response. When it is set, `librarySignals(game, true)` reports `playtime2Weeks` as unknown, and a last-played value of 0 ("never") as unknown too. Playtime-based modes and the banner that explains them are left to the packages that use the signal.

## Deploy prerequisite

Deploy the `games` index exemption from `firestore.indexes.json` (`firebase deploy --only firestore:indexes`) before this change reaches production. Without it, libraries above about 8,000 games hit Firestore's index-entry limit (see `qit-store-layer.md`).

## Tests

- `tests/qit-library-model.test.ts` (`npm test`): `lastPlayedAt`, the `getSteamGames` request and its field mapping, the conversions, the index patch diff, `planSync`, playtime-hidden detection and the signals.
- `tests/qit-library-model.emulator.test.ts` (`npm run test:firestore`): a sync that writes both stores, and library loads that cost 4 reads (`getStoredGames`), 5 (`getLibrary`) and 4 (`ownsGames`) with no Store calls. Also covered: other packages' fields surviving a resync, unknown `r` being cleared, removals, a sync with no changes writing no chunk, the legacy fallback and its migration, a library that becomes empty, the `playtimeHidden` flag merge, a private library writing nothing, and a 3,000-game sync.
- `tests/firestore.test.ts`: its sync test now checks that genres stay off the library load and the sync, and that the shared genre cache still works.
