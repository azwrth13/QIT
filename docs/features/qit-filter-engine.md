# Filter engine: session filters and the exclusion stage

The pure predicates behind session filters (feature 18, with the activity filter of feature 9) and the exclusion stage (feature 14, plus D17). The spin pipeline (`qit-spin-api`) loads the signals, calls `applyPool`, then scores and draws. The picker UI can call `poolPreview` for live counts. Nothing here reads Firestore or calls `fetch`.

There is no `installed` filter. Steam exposes no installed state, and the captain decided to drop it entirely (D14).

| File | Holds |
|---|---|
| `src/lib/roulette/filters/*.ts` | one real `Filter` per id (no longer stubs) |
| `src/lib/roulette/filters/params.ts` | param parsing helpers and the store-flag verdict |
| `src/lib/roulette/filters/recency.ts` | `playedWithin`, shared by the two recency filters |
| `src/lib/roulette/exclusions.ts` | `applyExclusions`, `exclusionRequires`, `NON_GAME_TYPES` |
| `src/lib/roulette/filter-engine.ts` | `parseFilterSelections`, `requiredFamilies`, `applyPool`, `poolPreview` |

## Verdicts and unknown

A filter returns `pass`, `fail` or `unknown`. `unknown` means the signal is not there yet: the family was not loaded, the app has no player counter, the store lists no such category, or a friend's library was unreadable. It is never read as zero or as a failure. `applyPool` decides what to do with it through `unknown`:

- `'exclude'` (the default) keeps a game out of the pool when it cannot be shown to match a filter the user chose.
- `'include'` keeps it.

Either way the preview counts the unknowns per filter, so the UI can say "12 games could not be checked" and offer to load more data.

## The filters

Params are untrusted JSON. `parse` returns `null` for anything invalid, including unknown keys, so a bad request is rejected instead of half-applied. A filter that takes no params accepts `undefined`, `null` or `{}`.

| Id | Requires | Params | Passes when |
|---|---|---|---|
| `multiplayer` | store | none | the multiplayer, co-op, PvP or MMO flag is true. All false fails; otherwise unknown |
| `co-op` | store | none | the co-op flag is true |
| `single-player` | store | none | the single-player flag is true |
| `achievements` | store | none | the store's achievements flag is true |
| `never-played` | library | none | `playtimeForever <= thresholds.neverPlayedMinutes` |
| `playtime` | library | `minMinutes?`, `maxMinutes?` (at least one, whole minutes, min <= max) | playtime is within the range, both ends inclusive |
| `recently-played` | library | `days?` (1 to 3650; default `recentRotationDays`, 30) | played within the window |
| `not-recently-played` | library | `days?` (default `notRecentlyPlayedDays`, 90) | not played within the window; a game with no playtime counts |
| `player-activity` | live | `mode`: `active`, `high` or `low` | see below |
| `shared-with-friends` | group | `with?` (Steam IDs, up to 16), `match?` (`all` default, or `any`) | the selected friends own it |
| `exclude-rolled` | history | `days?` (0 to 3650; default `antiRepeatDays`, 30; 0 is off) | not rolled inside the window |

Store flags are `true`, `false` or `null` (unknown); a missing `store` family is unknown too.

### Recency

`playedWithin(library, days, now)` combines `lastPlayedAt` and `playtime2Weeks`. Steam reports `rtime_last_played` as 0 for old sessions, which the library index stores as `null`, so a null time with playtime above zero is unknown. Two facts still settle it: `playtime2Weeks > 0` means played within the last 14 days (so within any window of 14 days or more), and `playtime2Weeks === 0` means not within 14 days. A game with no playtime and no timestamp has not been played in any window.

Playtime-hidden accounts read every game as zero minutes. The pipeline must disable `never-played`, `playtime` and the recency filters for them; the filters cannot tell.

### Player activity (the three modes of feature 9)

- `active`: at least `thresholds.activeMinPlayers` players now (the absolute floor of 100, D15). It needs no band.
- `high`: the candidate's `live.band` is `high` (the top quarter of the pool, P75) and it is at or above the floor.
- `low`: `live.band` is `low` (the bottom quarter, P25).

The bands come from `qit-player-counts`; the filter only reads `live.band`. A game with no counter (`players` null) is unknown in every mode, and `high` and `low` are also unknown while the band is null.

### Shared with friends

The friends checked are `params.with` if given, otherwise the friends the scope names (`friends` scope, or the `pair` friend), otherwise every player in the scope: `FilterContext.members` (the readable `ScopeResult.members` plus the `unavailable` ones) when the pipeline passes it, else every player in `signals.group`. The pipeline should pass `members` so an unreadable lobby player counts. A friend who is missing from `group.members` had no readable library, so they make the verdict unknown unless another friend already decides it. The requester always owns their own pool, so they never change a result.

## Exclusion stage

`applyExclusions(candidates, { exclude?, showNonGames? })` runs first and returns `{ kept, removed }`. Removals are counted by their first cause:

1. `vetoed`: `signals.history.excluded` is set. The history loader must set it only for exclusions still active (this session, today, 7 days, forever). The stage does not check dates.
2. `request`: the appid is in `exclude`, the current spin's own list.
3. `non_game`: D17. `signals.store.type` is a known non-game type (`application`, `software`, `tool`, `dlc`, `music`, `video`, `hardware`, `series`, `advertising`, compared case-insensitively). Hidden unless `showNonGames` is true. An unknown or missing type keeps the game, and so does a type the list does not know, such as `demo`.

`exclusionRequires(options)` lists the families the stage reads: `history` always, and `store` while non-games are hidden.

## Pipeline use

```ts
const parsed = parseFilterSelections(request.filters);      // { ok, filters } or { ok: false, error }
const stages = { exclusions: { exclude: request.exclude }, filters: parsed.filters };
const families = requiredFamilies(stages);                   // load these signals, then:
const { candidates, preview } = applyPool(pool, stages, { now, thresholds, scope });
```

`parseFilterSelections` rejects unknown ids, stubs, repeated ids, more than 11 filters and invalid params, and treats a missing list as no filters. `requiredFamilies` returns a union in a fixed order. `applyPool` combines filters with AND, in request order.

`preview` (also `poolPreview`) holds `total`, `removed` by cause, `afterExclusions`, one `step` per filter (`passed`, `failed`, `unknown`, `remaining`, counted over the games that reached it) and `final`. It is plain data, so it goes straight into an API response.

## Tests

`tests/qit-filter-engine.test.ts` covers every filter's verdicts (including unknown and boundary values), param validation, the exclusion causes, request parsing and the pool counts.
