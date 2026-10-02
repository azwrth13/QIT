# Challenge streaks and progression

Personal progress toward enjoying an existing Steam library. No leaderboard, rankings, or cross-user API.

## Integration

- `history/progression.ts` owns the single `QUALIFYING_ACTIONS` table. `played`, `daily_played`, `friend_night_played`, `challenge_complete`, and `rare_challenge_complete` earn a day. Daily and Friend Night emitters belong to their packages. Rolls, acceptance, rerolls, skips, and challenge issuance/acceptance do not earn days.
- Existing manual and sync played detection use `played`. Its metadata now snapshots `playtimeAtRoll`; older events resolve that value from their referenced roll. Unknown playtime never implies an untouched game.
- Existing challenge verification emits `challenge_complete` with `meta.kind = achievement | rare`. A rare completion counts as both a completed challenge and a rare achievement. The optional dedicated rare event kind supports future emitters; use the challenge ID as `refId` so both representations cannot double-count the challenge.
- `GET /api/user/stats` returns the signed-in user's existing counters, streak, progression, and last event update time. It uses the shared private response envelope and rate limiter. There is no target-user parameter.
- `StreakWidget` takes the `progression` DTO and performs no fetching. Empty, active, and lapsed fixtures are at `/dev/streaks` in development only. Navigation placement and any owning page are left to the later navigation package.

## Calendar and counter semantics

A streak is a run of distinct local calendar dates, not elapsed 24-hour windows. Multiple actions on a day count once. The current streak remains active through the day after the last credited day; it becomes zero at the following local midnight unless another qualifying action occurs. A new action after a gap starts at one. Longest retains the best run in the history.

The profile's validated IANA `tz` controls dates. The existing profile hook captures the browser timezone through `PATCH /api/user/profile` with `{tz, onlyIfMissing: true}`. This is transactional and never overwrites a previously saved setting, including a concurrent settings change. An explicit `{tz}` patch changes the setting. Invalid or missing stored zones use UTC until capture succeeds. Capture failures do not prevent profile display and retry on the next profile load.

Timezone changes reinterpret the immutable event instants using the newly selected zone. Both current and longest are recomputed consistently; travel can therefore combine or split historic days and change the displayed longest. No timestamps or counters are rewritten. Spring-forward, fall-back, repeated hours, and local midnight use calendar dates throughout.

- **Games discovered:** distinct app IDs actually played after a QIT recommendation, including Daily and Friend Night plays; simply viewing or accepting a roll adds nothing.
- **Backlog games started:** distinct played app IDs whose playtime at recommendation was exactly zero. Repeated zero-minute rolls for the same game cannot inflate this count.
- **Challenges completed:** distinct completed challenge IDs, falling back to event identity when a producer has no reference ID.
- **Rare achievements completed:** the subset completed as rare challenges. This does not count unrelated Steam unlocks.

## Storage and replay

`history/stats.ts` remains the only writer of `stats/summary`. Event creation atomically increments the existing counters and an event revision. Progression is a lazy, transactionally consistent projection: `readStats` reads the revision and profile, rebuilds from events when necessary, and stores a small cache plus the existing `streak` fields. The cache is invalidated by an event, timezone change, new local day, backwards test clock, or a previously future event becoming due. Repeated reads of unchanged history use two document reads and no writes. Summary `updatedAt` remains the last event write time, not a page-view time.

The pure reducer deduplicates event IDs and is order-independent. `recordEvent(user, event, now, stableEventId)` additionally supports transactional first-write-wins replay at ingestion; a repeated ID neither appends an event nor increments any existing counter. Callers without a stable ID deliberately create a new event. Existing played and challenge state machines already emit once per state transition. The projection does not trust a persisted current streak to stay fresh after missed days.

A cache miss reads the user's event history and the referenced rolls only for legacy played events without playtime metadata. It stores no unbounded arrays or ID maps in the summary. This favors exact backfill, arbitrary event order, and timezone reprojection over an incremental day ledger. Cost grows with history on cache misses; a future storage optimization can materialize per-day/per-game documents while preserving these semantics. No retention or infrastructure changes are included here.

## Verification

Unit tests cover qualifying versus nonqualifying actions, out-of-order events, duplicate IDs, distinct game counters, and future event rejection. Route tests cover session identity, same-origin enforcement, invalid timezone payloads, and private responses. Emulator tests cover consecutive days, missed-day expiry, longest retention, same-day deduplication, concurrent replays, both DST transitions, repeated DST hours, local midnight, timezone capture and change, automatic/manual played marks, legacy history, and cache invalidation for late events. The existing event-store, played-detection, and challenge-tracker emulator suites exercise compatibility with their emitters.

The current Vitest setup preserves JSX rather than rendering React components; the presentational widget uses the development fixture gallery, without changing shared test tooling for this package.

Validated locally: 561 unit tests, 84 emulator tests, TypeScript typecheck, and ESLint pass. After the final cache-map replacement change, the 8 streak emulator tests and 7 progression/route unit tests pass again. The emulator used an isolated demo project and task-specific ports; no shared Firebase configuration was changed.
