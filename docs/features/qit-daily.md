# Daily QIT

Daily QIT ships `/daily`, an authenticated home widget, and `/api/daily`. Only the `daily` navigation flag is enabled by this package. It requires the already merged roulette pipeline, modes/filter engine, event store, profile timezone API, and result card/veto controls. It does not require the new picker, friend dashboard, privacy page, or lobby roulette.

## Selection and persistence

The browser captures its IANA timezone with the existing `PATCH /api/user/profile` before reading today's recommendation. That API preserves an existing valid stored timezone. Server-side dates use the profile's `tz`; API-only callers without a saved timezone use UTC. Daily rollover uses the shared DST-aware local-day helpers. A tab refreshes at the local boundary or upon returning to it; every mutation also checks the server's current local date.

`users/{steamId}/daily/{yyyy-mm-dd}` stores the complete card, reasons, seed, coverage, playtime baseline, chosen mode, daily settings, status, three-reroll counter, and all earlier selections that day. Selection/decision times are Firestore Timestamps and become milliseconds in the API. Snapshotting preserves today's game, enrichment and explanation across refreshes, library syncs, preference changes, and subsequent vetoes. An empty result is also a stable saved daily; syncing the library does not silently replace it. A capped reroll can retry an empty result.

Selection runs the merged `runSpin` pipeline with its seeded sampler, library scope, signal loaders, non-game filtering, active vetoes, and anti-repeat filter. All external Steam access still goes through the existing bounded loaders, Steam client and global budget path; Daily adds no direct Steam HTTP calls. Steam enrichment runs outside retryable transactions. The `recordRoll` adapter captures the baseline without writing an independent roulette roll. The winning transaction creates the daily snapshot and its `daily_roll` event atomically, through the existing event/stats writer. Racing requests can prepare draws, but only the saved winner emits an event. No losing draw creates orphan history or counter increments.

Daily cards use `rollId: null`: they are owned by Daily, not by the generic roulette roll store. Daily history is folded into the existing history loader for subsequent Daily anti-repeat filtering, along with ordinary roulette history and vetoes. Up to 92 daily records and their at-most-four selections are read with one date-range query, covering the maximum 90-day window. Queries use the indexed `date` field; Firestore does not support descending document-key scans. No composite index or infrastructure change is required.

## Defaults and actions

Defaults are stored as `dailySettings` on the existing profile. The default is **Backlog mix**, combining Dust Collector, Rediscovery, Finish Something, and Something Different with their existing scores and eligibility checks. A candidate's weight combines eligible component scores; a deterministic weighted component draw chooses its explanation. The card stores and displays the actual component mode and its reasons. Missing achievement signals leave the other mix components usable. If no component finds a game, the result is empty.

The modes catalog offers every shipped mode supporting the library scope, including Pure Random and live/achievement modes. Group-only Everyone Owns It requires participants, so it is not offered for a personal daily. No link to an unshipped group surface is shown. Defaults apply next local day; today's saved settings continue to govern its rerolls. Anti-repeat choices are off, 7, 30 (default), or 90 days. Today's earlier picks are always excluded from rerolls, even with anti-repeat off.

Actions carry the displayed date and reroll revision, preventing stale tabs or retried requests from applying to a replacement pick:

- **Accept** records `daily_accept`. It awards no streak credit. Repeated acceptance of the same selected game is idempotent.
- **Reroll** records `daily_reroll`, retains the earlier snapshot, and increments the cap transactionally. Exactly three rerolls are allowed per local day; a failed request consumes none, while a successful empty reroll consumes one. Accepted picks can be rerolled before being marked played.
- **Skip** records `daily_skip` and ends the day. It cannot be reopened or marked played, and earns no Daily streak credit.
- **I played it** records one `daily_played` event with the game and original playtime baseline. Existing progression recognizes this qualifying action, counts the user's local day, and deduplicates games discovered. Repeated marks are idempotent; a played daily is terminal.
- **Launch in Steam** opens the selected game without claiming that it was played. The shared Steam store and veto controls remain available. Hiding a game affects future draws, preserving the saved daily snapshot.

`daily_accept` integrates with the shipped profile's dailies-accepted statistic. `daily_played` integrates with shared streaks and discovery metrics. `daily_roll`, `daily_reroll`, and `daily_skip` are also counted by the shared event store. Manual play confirmation is supported here. The generic sync detector currently owns roulette roll records; automatic Daily play detection would need an explicit cross-package integration and is outside this package. No duplicate stats or streak writer was added.

## API

All responses are private and uncached. Identity always comes from the session. GET and POST have per-user/per-IP limits; every POST uses the shared Origin/Referer guard and a 1 KiB JSON body cap. Unexpected failures use safe `logServerError` and a generic error envelope.

- `GET /api/daily`: transactionally create/read today's stable recommendation; return `today`, `settings`, `tz`, `now`, `nextDayAt`.
- `GET /api/daily?history=1&cursor=yyyy-mm-dd`: newest-first saved Daily snapshots, at most 20 per page, with `nextCursor`. History is user-isolated and includes previous rerolls. It never creates a pick.
- `POST /api/daily` with `{ action: 'accept' | 'reroll' | 'skip' | 'played', date, revision }`: apply a guarded current-day action and return updated Daily state. Stale/terminal conflicts return 409. Client-supplied identity, unknown keys, invalid dates/revisions, and unsupported actions are rejected.
- `POST /api/daily` with `{ action: 'settings', settings: { mode, antiRepeatDays } }`: validate and save future defaults. Unsupported/group-only modes or windows are rejected.

## Validation

`tests/qit-daily.routes.test.ts` executes the page auth guard and route interfaces for session/Origin refusals, malformed and oversized input, private responses, settings/history requests, identity isolation, 409 conflicts, safe errors and rate limiting.

`tests/qit-daily.client.test.ts` executes the browser API adapter to verify timezone-first initialization, stale-date/revision requests, settings payloads and server-error propagation.

`tests/qit-daily.view.test.tsx` renders actual card/page sections and the widget for loading/error, ready/accepted, skipped/played, capped rerolls, historical and empty states, absent enrichment, partial coverage and earlier rerolls.

`tests/qit-daily.emulator.test.ts` uses the real Firestore transaction/event/library/filter/scoring layers with Steam access disabled. It covers concurrent first reads, unchanged snapshots after library/default changes, idempotent decisions, qualifying play events, terminal skips, concurrent capped rerolls, ordinary/Daily anti-repeat, vetoes, empty pools, deterministic mixed-mode explanations, missing achievements, DST/timezone boundaries, stale dates/revisions, pagination and user isolation. Tests require `FIRESTORE_EMULATOR_HOST` and otherwise skip.

## Package boundary notes

- Existing history loaders bound ordinary roulette history to 500 rolls. Daily history is independently bounded to its calendar window.
- Automatic Daily sync detection and a group-scoped Daily preference would require changes to the owners of those shared APIs. This package does not modify their writers or sibling pages.
- Profile most-used-mode reporting currently reads ordinary roulette mode counters. Daily events remain separately named; extending shared mode statistics is left to that package.
- Infrastructure, deployment configuration, short-link/auth implementation, and README are untouched.
