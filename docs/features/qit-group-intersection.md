# Group library intersection, comparison, filters and reasons

Pure library functions for features 1, 2, 3, 10, 11 and 15, exported from `src/lib/group/index.ts`. This package adds no routes, storage, Steam calls, UI or navigation.

`GroupLibrary` takes a player `steamId`, a `ReadonlyMap<number, LibIndexEntry>` of games, and an optional `playtimeHidden` flag. The merged social `FriendLibrary` structurally fits this input; callers must attach the hidden-playtime flag when available. Library-index entries retain the existing compact field conventions (minutes in `p` and `w`, Unix seconds in `r`). The social reader currently does not return a hidden-playtime flag; propagating that flag belongs to its caller/data package, not this pure engine. Do not infer hidden playtime inside this engine from an all-zero library, because a genuinely unplayed library has the same shape.

## Intersection and comparison

- `intersect(libraries)` returns only games every selected player owns, sorted by appid. Empty input returns no games; one player returns their library. Duplicate or empty player IDs and libraries with non-`ok` states throw. The caller must explicitly resolve unavailable players before choosing a group; the engine never silently reduces the group.
- Each returned `GroupGame` includes name and icon from the first owner in input order, owners, per-player minutes (`playtimeByPlayer`), `playedBy`, `neverPlayedBy`, and `unknownPlaytimeBy`. Its `group.members` conforms to roulette `GroupSignals`, with additional per-player recency fields. Outputs contain fresh objects and do not mutate input maps or entries.
- `compareLibraries(a, b, { now, notRecentlyPlayedDays? })` returns `both`, `onlyA`, `onlyB`, `neitherRecentlyPlayed`, and `oneNeverPlayed`. The last two are overlapping subsets of shared games. `oneNeverPlayed` means at least one known zero, including games neither player has played. Non-owners have null minutes and never enter playtime classifications.
- `now` is required in Unix seconds to keep comparison deterministic and pure. The recency window defaults to the existing `THRESHOLDS.notRecentlyPlayedDays` (90 days). Comparison reuses roulette's `playedWithin`: the exact window boundary is recent, two-week activity can override a stale timestamp, zero lifetime minutes is outside the window, and missing timestamps for played games remain unknown unless two-week data settles the window. Hidden or missing lifetime playtime never proves inactivity.

## Never-played-together filters

Feature 15 identifies shared games that one or more players have never played. All four predicates take `GroupSignals`, so call them with `game.group`. They return booleans and require every selected player to own the game. They are pure group predicates for later Friend Night and lobby packages, rather than additions to the feature 18 session-filter registry.

| Predicate | Match |
|---|---|
| `nobodyPlayed(group)` | Every player has exactly zero minutes. |
| `atLeastOneNeverPlayed(group)` | At least one player has exactly zero minutes. |
| `everyoneUnderHours(group, hours)` | Every player has known minutes strictly below `hours * 60`. |
| `veteranWithNewcomers(group, experiencedHours?)` | Exactly one veteran has at least the threshold minutes and every other player has zero minutes. At least two players required. |

`EXPERIENCED_HOURS` defaults to 10 hours, aligned with D5's meaningful playtime default. The veteran threshold is overridable per call. Under-hours requires an explicit parameter. Both hour parameters must be finite and positive; fractional hours are supported. Invalid thresholds throw `RangeError`.

Empty groups fail every predicate. A single player with zero minutes matches the first three but cannot match veteran-with-newcomers. Hidden playtime is null, never zero: it cannot establish never-played, under-hours or veteran status. A known never-played owner can still establish `atLeastOneNeverPlayed` even when another owner's playtime is unknown. Missing, negative and non-finite index playtime also normalize to null.

## Reasons and integration

`groupReasons(game.group)` returns existing structured roulette reasons, with ownership first and known never-played count second. It emits `friends_all_own` only for a nonempty group where everyone owns the game, and `friends_never_played` only for a positive count of known-zero owners. Hidden players contribute to ownership but not playtime reasons. Use the existing `renderReason` / `renderReasons` to produce text such as “All 4 players own it” and “2 players have never played it”; there are no ad-hoc reason strings or new reason codes.

Later scope packages can attach `game.group` to candidate signals and append `groupReasons` before card rendering. They remain responsible for requester library signals, unavailable-player decisions, player names/avatars and hidden-playtime flag propagation. This package deliberately stops at the pure library boundary.

## Validation

`tests/qit-group-intersection.test.ts` covers intersection, ownership partitions, shared recency and never-played subsets, all four predicates, reason values and rendered text, empty and single-player inputs, hidden/missing/invalid playtime, threshold boundaries, unavailable/duplicate players and input immutability. No emulator, route or fetch tests are needed because this package performs no I/O.
