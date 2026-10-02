# Played-after-roll detection

Library sync compares Steam's total minutes with each roll's original `playtimeAtRoll`. An increase of at least `THRESHOLDS.playedDeltaMinutes` (10 minutes, D4/D5) marks the roll played with source `sync`. A smaller increase, reduced total, missing game, or unknown baseline leaves the roll pending. The comparison always uses the roll baseline, so several smaller sync increments can accumulate to the threshold.

The baseline comes from the stored library index, which can be stale. When Steam reports `rtime_last_played`, it must also be at or after the roll time, so playtime from before the roll is not counted. Without `rtime_last_played`, the delta alone decides.

One play session counts once per game. For each game, detection walks its recent rolls newest first and marks only the first qualifying unplayed roll. It stops at an already played roll, so a re-sync never marks older rolls of that game for the same session.

`src/lib/history/played.ts` provides `hasPlayedDelta` and `detectPlayedRolls`. Detection calls only `markPlayed` from the event store. That transaction atomically sets `playedAt`/`playedSource`, appends the played event with `meta.source`, and increments played counters. Re-syncs and concurrent detections count once. Played remains independent of accepted/rerolled status.

Manual marking remains available through `PATCH /api/history { rollId, action: "played" }`, using the same transaction with source `manual`. The established event-store rule is first mark wins: a prior manual mark keeps its timestamp/source when sync later qualifies, and a prior sync mark is likewise preserved when manually marked later. No UI or navigation changes are included.

## Sync integration and bounds

The shared `syncLibrary` writer runs detection after per-game documents, the library index, and the profile/hidden-playtime flag have been persisted. This covers `POST /api/games/sync` and autosync callers. Private libraries return before detection. Hidden playtime is no signal: detection skips history reads and leaves every baseline/mark unchanged. When totals become visible again, the original roll baseline can qualify.

Detection is best effort. Errors use `logServerError('Played detection failed', error)` and the sync still returns its successful library response. A later sync retries even if the library index itself has no changes; completed marks remain idempotent.

`recentRolls` in `src/lib/history/rolls.ts` makes one single-field range query on `at`, newest first. It includes played rolls, which stop the per-game walk. Its tunable constants are:

| Constant | Default | Purpose |
|---|---|---|
| `PLAYED_DETECTION_WINDOW_DAYS` | 30 days | Excludes older history |
| `PLAYED_DETECTION_ROLL_LIMIT` | 100 rolls | Caps document reads and potential mark transactions per sync |
| `THRESHOLDS.playedDeltaMinutes` | 10 minutes | Minimum increase since the roll |

The upper range bound is the sync completion time. Played timestamps use the sync completion timestamp. There are no additional Steam calls, library reads, composite indexes, or direct writes to rolls/events/stats from the detector.

The cap includes already played rolls. Older rolls outside either bound require manual marking; this package deliberately does not scan or backfill the whole history. Steam's hidden-playtime heuristic belongs to library-model and remains unchanged. Steam may update totals only after a game closes; detection waits for those totals to appear.

## Validation

- `tests/qit-played-detection.test.ts`: 9/10-minute edge, zero baseline, invalid/unknown/reduced totals, missing games, stale baselines via `rtime_last_played`, one mark per game per session, hidden and empty libraries, sync source, and transaction outcomes.
- `tests/qit-played-detection.emulator.test.ts` via `npm run test:firestore`: real sync/store integration, idempotent re-sync and concurrent detection, manual source preservation, hidden-to-visible recovery, unknown/missing/reduced playtime, stale index baselines, several rolls of one game, history window/cap, private library, and the sync route returning 200 with persisted library data when detection fails followed by a successful retry.

Local validation passed: `npm test`, `npm run test:firestore`, `npm run typecheck`, and `npm run lint`.

Later daily, streak, history and statistics surfaces can consume the existing played event/source. They remain outside this package.
