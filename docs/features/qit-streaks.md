# Challenge streaks and progression

Personal progress toward enjoying an existing Steam library. No leaderboard, rankings, or cross-user API.

## Integration

- `history/progression.ts` owns the single `QUALIFYING_ACTIONS` table. `daily_played`, `friend_night_played`, and `challenge_complete` earn a day; a roulette `played` earns a day only when the game was untouched (`playtimeAtRoll === 0`). Daily and Friend Night emitters belong to their packages. Rolls, acceptance, rerolls, skips, and challenge issuance/acceptance do not earn days.
- Existing manual and sync played detection use `played`. Its metadata now snapshots `playtimeAtRoll`; older events resolve that value from their referenced roll. Unknown playtime never implies an untouched game.
- Existing challenge verification emits `challenge_complete` with `meta.kind = achievement | rare`. A rare completion counts as both a completed challenge and a rare achievement. Future emitters use the same event with the challenge ID as `refId`.
- `GET /api/user/stats` returns the signed-in user's existing counters, streak, progression, and last event update time. It uses the shared private response envelope and rate limiter. There is no target-user parameter.
- `StreakWidget` takes the `progression` DTO and performs no fetching. A server-render unit test covers its empty, active, and lapsed states. Navigation placement and any owning page are left to the later navigation package.

## Calendar and counter semantics

A streak is a run of distinct local calendar dates, not elapsed 24-hour windows. Multiple actions on a day count once. The current streak remains active through the day after the last credited day; it becomes zero at the following local midnight unless another qualifying action occurs. A new action after a gap starts at one. Longest retains the best run in the history.

The profile's validated IANA `tz` controls dates. The existing profile hook captures the browser timezone through `PATCH /api/user/profile` with `{tz}`. Capture is transactional and never overwrites a previously saved valid zone; the response returns the stored zone. There is no settings UI to change it yet. Invalid or missing stored zones use UTC until capture succeeds. Capture failures do not prevent profile display and retry on the next profile load.

Timezone changes reinterpret the immutable event instants using the newly selected zone. Both current and longest are recomputed consistently; travel can therefore combine or split historic days and change the displayed longest. No timestamps or counters are rewritten. Spring-forward, fall-back, repeated hours, and local midnight use calendar dates throughout.

- **Games discovered:** distinct app IDs actually played after a QIT recommendation, including Daily and Friend Night plays and already-played games that do not earn a streak day; simply viewing or accepting a roll adds nothing.
- **Backlog games started:** distinct played app IDs whose playtime at recommendation was exactly zero. Repeated zero-minute rolls for the same game cannot inflate this count.
- **Challenges completed:** distinct completed challenge IDs, falling back to event identity when a producer has no reference ID.
- **Rare achievements completed:** the subset completed as rare challenges. This does not count unrelated Steam unlocks.

## Storage and replay

`history/stats.ts` remains the only writer of `stats/summary`. Event creation atomically increments the existing counters and, for qualifying event types only, an event revision. Progression is a lazy, derived projection computed without a transaction, so reads never contend with event writers: `readStats` reads the revision and profile first, then rebuilds from events when necessary and blind-merges a small cache plus the existing `streak` fields. Because the revision is read before the events, a cache is never labelled newer than the events it saw; a racing event or an older overwrite only causes a recompute. The cache is invalidated by a qualifying event, timezone change, new local day, backwards test clock, or a previously future event becoming due. Repeated reads of unchanged history use two document reads and no writes. Summary `updatedAt` remains the last event write time, not a page-view time.

The pure reducer deduplicates event IDs and challenge `refId`s and is order-independent. Existing played and challenge state machines already emit once per state transition. The projection does not trust a persisted current streak to stay fresh after missed days.

A cache miss queries only the user's qualifying event types and reads the referenced rolls only for legacy played events without playtime metadata. It stores no unbounded arrays or ID maps in the summary. This favors exact backfill, arbitrary event order, and timezone reprojection over an incremental day ledger. Cost grows with history on cache misses; a future storage optimization can materialize per-day/per-game documents while preserving these semantics. No retention or infrastructure changes are included here.

## Verification

Unit tests cover qualifying versus nonqualifying actions, out-of-order events, duplicate IDs, distinct game counters, and future event rejection. Route tests cover session identity, same-origin enforcement, invalid timezone payloads, and private responses. Emulator tests cover consecutive days, missed-day expiry, longest retention, same-day deduplication, replayed challenge completions, both DST transitions, repeated DST hours, local midnight, timezone capture and change, automatic/manual played marks, legacy history, and cache invalidation for late events. The existing event-store, played-detection, and challenge-tracker emulator suites exercise compatibility with their emitters.

The emulator used an isolated demo project and task-specific ports; no shared Firebase configuration was changed.
