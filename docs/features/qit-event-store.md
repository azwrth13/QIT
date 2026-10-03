# Event store

`src/lib/history/` holds the per-user history stores: rolls, the event log, exclusions and the stats summary. Each document has exactly one writer module, and every change records an event and its stats counters in the same Firestore transaction, so the counters never drift from the log. Nothing here renders UI; later packages (spin API, exclusions, played detection, daily, history page, streaks, profile) build on it.

| Module | Only writer of | Exports |
|---|---|---|
| `rolls.ts` | `users/{id}/rolls/{rollId}` | `recordRoll`, `markAccepted`, `markRerolled`, `markPlayed`, `getRoll`, `listRolls`, `recentlyRolled` |
| `events.ts` | `users/{id}/events/{eventId}` (append-only) | `recordEvent`, `stageEvent` (inside a caller's transaction) |
| `stats.ts` | `users/{id}/stats/summary` | `readStats`; counters move only through events |
| `exclusions.ts` | `users/{id}/prefs/exclusions` | `addExclusion`, `removeExclusion`, `readExclusions`, `listExclusions`, `endExclusionSession` |
| `time.ts` | none (pure) | `endOfLocalDay`, `localDate`, `isValidTimeZone` |

## Rolls

A roll stores `appid`, `name`, `modeId`, `filters`, `scope` (the full `Scope`, so the history page can re-roll with the same settings), `participants` (requester first), optional `lobbyId`, `at`, `status`, `playtimeAtRoll` (minutes, `null` when unknown) and `reasons`.

- `status` is the decision on the card: `rolled` -> `accepted` or `rolled` -> `rerolled`. Repeating the same change is `unchanged`; the other change is a `conflict` (an accepted roll cannot be rerolled, nor a rerolled one accepted). A missing roll is `not_found`.
- Played is separate from status (`playedAt`, `playedSource: 'sync' | 'manual'`), because a rerolled game can still be played. The first mark wins, so a later manual mark does not overwrite a sync detection (captain decision D4).
- `recentlyRolled(steamId, { days, now })` returns `Map<appid, { count, lastRolledAt }>` (Unix seconds, as `HistorySignals` expects) for every roll in the window, whatever was decided. `days` defaults to the 30-day anti-repeat window (D6); `0` means off. One range query, at most 500 reads.
- `listRolls(steamId, { limit, cursor })` pages newest first. The cursor holds the full timestamp plus the roll id, so rolls sharing a millisecond are neither skipped nor repeated.

## Events and stats

`recordEvent(steamId, { type, appid?, refId?, meta? })` appends an event and increments counters. Types are `[a-z][a-z0-9_]{0,39}`; `meta` is plain JSON of at most 2 KiB. This package writes `roll`, `accept`, `reroll`, `played`, `exclude` and `unexclude`. Other packages add their own types without editing this module. A package that changes one of its own documents in a transaction calls `stageEvent(tx, ...)` so the change and the event commit together.

Every event increments `counters[type]`. For `roll` and `accept` it also increments `type:modeId:<mode>`, for `played` it increments `played:source:<source>`, for `exclude` it increments `exclude:scope:<scope>`, and for `challenge_complete` it increments `challenge_complete:kind:<kind>` (`COUNTER_DIMENSIONS` in `stats.ts`). Increments are blind merge writes, so concurrent events do not contend and none are lost. Qualifying event types also bump `eventRevision`; the `streak` field and progression cache are derived on read (see [qit-streaks](qit-streaks.md#storage-and-replay)).

## Exclusions

One map doc keyed by appid, so a spin reads every exclusion in one read. Scopes follow D8:

| Scope | Ends |
|---|---|
| `session` | when the owning picker or lobby session ends (`endExclusionSession`); needs a `sessionId`, and it only applies to reads with that id. No clock deadline; entries written with the former 12-hour deadline still expire then |
| `day` ("Not tonight") | at the user's next local midnight in the `tz` passed (IANA; UTC when missing or invalid). DST-safe (D3) |
| `7d` | 7 days later |
| `forever` | only when `removeExclusion` un-hides it |

A new exclusion replaces an earlier one for the same game. The exception is a `forever` exclusion, which stays until it is un-hidden, so adding a shorter one returns the existing entry and writes nothing. Every write rewrites the doc without expired entries. There are at most 1,000 active entries (`ExclusionLimitError`), because every map subfield of this doc is indexed and the cap keeps it far below Firestore's 40,000 index entries per document. Readers check expiry themselves.

## API

`/api/history` (session required; `Cache-Control: private, no-store`; errors use the route-guards envelope):

- `GET ?limit=1..50&cursor=` returns `{ rolls, nextCursor }` for the signed-in user. Dates are ISO strings.
- `PATCH { rollId, action }`, where `action` is `accept`, `reroll` or `played` (a manual "I played it"). It needs a same-origin request. It returns `{ outcome: 'updated' | 'unchanged', roll }`, `404 { error: { code: 'not_found' } }` or `409 { error: { code: 'conflict' }, roll }`.

Both methods have per-user and per-IP token buckets. Rolls are only ever read and written under the session's own Steam ID.

## Indexes

No composite indexes. The only queries are on `rolls`, ordered by `at` (with a range on `at`, and the document id as a tiebreak in the same direction). `events` is write-only here; a package that queries it by type and recency adds the composite index it needs.

## Tests

- `tests/qit-event-store.test.ts` (`npm test`) covers counter keys, event validation, local-day and DST edges, exclusion scopes and pruning, roll validation, cursors, and the route (auth, same-origin, validation, 404/409 mapping, rate limit, error hiding).
- `tests/qit-event-store.emulator.test.ts` (`npm run test:firestore`, skipped without the emulator) covers the roll lifecycle with events and counters, exact counters under concurrent writes, the anti-repeat window, paging over rolls that share a timestamp, exclusion scopes, replacement, pruning, un-hide and the cap, and other packages' event types.
