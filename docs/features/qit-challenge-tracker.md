# Challenge tracker

`src/lib/history/challenges.ts` runs the challenge lifecycle used by Achievement Hunt (feature 4), Rare Achievement Challenge (feature 5) and challenge streaks (feature 7). A challenge is issued, accepted, verified against Steam, and then completed or expired. Each transition records an event that streaks and stats read. This package adds no UI. The Achievement Hunt and Rare Challenge pages build on `/api/challenges`.

| File | Contents |
|---|---|
| `src/lib/history/challenges.ts` | The only writer of `users/{id}/challenges/{challengeId}`: the state machine, issue, accept, decline, verify, expire, list |
| `src/app/api/challenges/route.ts` | `GET`, `POST` and `PATCH /api/challenges` |
| `src/lib/store/types.ts` | `ChallengeRecord` (tightened), `ChallengeKind`, `ChallengeStatus`, `ChallengeUnlock` |
| `src/lib/history/stats.ts` | One added counter dimension: `challenge_complete` by `kind` |

## Kinds

| Kind | Target | Done when |
|---|---|---|
| `achievement` | one locked achievement (`apiname`) | that achievement is unlocked at or after acceptance |
| `rare` | one locked achievement whose Steam global unlock percent is at or below the tier `threshold` (25, 10 or 5) | same as `achievement` |

One achievement backs at most one active (issued or accepted) challenge per user, whatever its kind, so one unlock completes at most one challenge.

## State machine

```
issued --accept--> accepted --verify--> completed
   |                   |
   +--decline--> declined
   +--(expiresAt passes)--> expired <--(expiresAt passes)--+
```

`TRANSITIONS` lists every legal move, and `stageTransition` refuses anything else, so no code path can write an illegal move. Every transition runs in a Firestore transaction that re-reads the challenge first:

- Repeating the current status returns `unchanged`. Examples: accepting an accepted challenge, declining a declined one, verifying a completed one.
- Any other move from the current status returns `conflict` with the stored challenge. Examples: accepting a declined, completed or expired challenge, declining an accepted one, verifying an issued one, expiring before `expiresAt`.
- A challenge that is still `issued` or `accepted` after its `expiresAt` is expired first, whatever was asked. The requested move then meets an expired challenge and gets a `conflict`.

| Window | Length (`CHALLENGE_TTL_MS`) |
|---|---|
| Offer: an issued challenge not yet accepted | 3 days from issue |
| Attempt for `achievement` | 7 days from acceptance |
| Attempt for `rare` | 14 days from acceptance |

Expiry is applied lazily. It happens on the next accept, decline or verify of that challenge, on every list (`expireOverdueChallenges` runs before the read), or when `expireOverdueChallenges(steamId)` is called directly. The record keeps `issuedAt`, `acceptedAt`, `completedAt`, `declinedAt` and `expiredAt`, all Firestore `Timestamp`s. `expiresAt` holds the end of the offer while the challenge is issued and the end of the attempt once it is accepted.

## Issue

`issueChallenge(steamId, { kind, appid, apiname, threshold? })`:

1. Validates the input shape (`validateChallengeInput`).
2. Reads the library index. The result is `needs_sync` when the index is not built yet and `not_owned` when the game is not in it.
3. Reads the user's active (issued or accepted, not overdue) challenges. If one is on the same achievement (`appid` and `apiname`), the result is `existing` with that challenge when the request is the same (same kind and threshold), and `conflict` with that challenge otherwise. Steam is not called in either case.
4. Reads the game's achievement record through the achievements data. If the record is missing or stale, it fetches it once through the shared Steam client and stores it with `saveAchievementRecords`. While the user's private marker is fresh, Steam is not asked and the result is `private`. A Steam private answer also sets the marker.
5. Checks the target. A game without stats is `no_achievements`. An `apiname` that is not in the stored locked list is `not_locked`. The achievement's English name and description are copied onto the challenge for display.
6. For `rare`, fetches the game's global unlock percentages (`getGlobalAchievementPercentages`, keyless, through the shared Steam client). The result is `not_rare` unless the achievement's percent is at or below `threshold`. A game Steam has no global stats for, or an achievement missing from them, is also `not_rare`. The client's tier is never trusted.
7. In a transaction, re-reads the active challenges and repeats the step 3 check, so racing issues for one achievement create one challenge. At 20 active challenges the result is `limit`. Otherwise the challenge is created with its `challenge_issue` event.

## Verify

`verifyChallenge(steamId, id)` only proceeds for an `accepted` challenge that is not overdue. It re-fetches that one game's achievements with `getPlayerAchievements` (shared Steam client, `l=english`). It never takes an unlock from the client. An achievement counts only when it is unlocked **and** its `unlocktime` is at or after the acceptance second (`unlocktime >= floor(acceptedAt / 1000)`; Steam reports whole seconds). An unlock with no time (Steam's `0`) never counts. So an achievement unlocked before acceptance, including between issue and acceptance, does not complete the challenge.

| Result | Meaning |
|---|---|
| `updated` | Completed now. The challenge stores `completedAt` and `unlocks` (`[{ apiname, unlocktime }]`, the target's unlock) |
| `unchanged` | It was already completed. Steam is not called |
| `pending` | No qualifying unlock yet. Includes `progress: { unlocked: 0, required: 1 }` |
| `private` | Steam does not share the user's achievements. The achievements-data private marker is set, and Steam is not asked again until it lapses (one hour) |
| `conflict` | The challenge is not `accepted`, or it was overdue and has now expired |
| `not_found` | No such challenge for this user |

Each Steam answer is also stored as the game's achievement record (`saveAchievementRecords`), which keeps the picker's achievement data and index summary current. A failed write there, or of the private marker, is logged and does not affect the verify. Other Steam failures throw `SteamClientError`.

The completion itself is a transaction that re-reads the challenge. When verify calls race, the first commit completes the challenge and every later one sees `completed` and returns `unchanged`. The challenge is completed and its event recorded exactly once.

## Events

Each transition stages its event with `stageEvent` from `src/lib/history/events.ts`. That is the event store's form of `recordEvent` for use inside a caller's transaction, so the status change, the event and its counters commit together. Nothing here writes `stats/summary` directly.

| Event type | When | `meta` |
|---|---|---|
| `challenge_issue` | issued | `kind`, `threshold?` |
| `challenge_accept` | accepted | `kind`, `threshold?` |
| `challenge_decline` | declined | `kind`, `threshold?` |
| `challenge_complete` | completed | `kind`, `threshold?`, `unlocks` (how many counted) |
| `challenge_expire` | expired | `kind`, `threshold?`, `from` (`issued` or `accepted`) |

Every event has `appid` and `refId` set to the challenge id. Counters: one per type, and `challenge_complete:kind:<kind>` from the new `COUNTER_DIMENSIONS` entry. For example, profile stats can read "rare challenges completed" as `challenge_complete:kind:rare`. Streaks can count completions from the `challenge_complete` events at their `at` times.

## API

`/api/challenges` needs a session. Responses carry `Cache-Control: private, no-store`, dates are ISO strings, and errors use the route-guards envelope `{ error: { code, message } }`.

| Method | Body or query | Response |
|---|---|---|
| `GET` | `?status=active\|all` (default `all`), `limit=1..50`, `cursor` (`all` only) | `{ challenges, nextCursor }`, newest first. `active` returns every issued and accepted challenge, unpaged |
| `POST` | `{ kind, appid, apiname, threshold? }` | `201 { outcome: 'created', challenge }` or `200 { outcome: 'existing', challenge }`. `404` with code `not_owned`. `409 { error: { code: 'conflict' }, challenge }` when another challenge on that achievement is open. `409` with code `needs_sync`, `private`, `no_achievements`, `not_locked`, `not_rare` or `limit` and a user-facing message |
| `PATCH` | `{ challengeId, action }` where `action` is `accept`, `decline` or `verify` | `200 { outcome, challenge }`. A pending verify adds `progress`. A private verify returns `outcome: 'private'` with a `message`. `404 not_found`. `409 { error: { code: 'conflict' }, challenge }` |

`POST` and `PATCH` require a same-origin request and a body of at most 1 KiB. Rate limits are per user and per IP token buckets. Reads use 30 per user, refilling 1/s. Accept and decline use 20, refilling one every 2 s. Issue and verify can each cost a keyed Steam call, so they use 10, refilling one every 5 s. Steam throttling or an exhausted key budget returns `429` with `Retry-After`. Other failures return the shared `502` without details.

## Indexes and cost

There are no composite indexes. The queries are `status in [issued, accepted]` (single field, no order) and `orderBy(issuedAt).orderBy(__name__)` for paging, which a single-field index serves the same way rolls are paged.

- Issue: 4 index reads, one active-set query, 1 or 2 achievement reads, at most 1 keyed Steam call (only when the game's record is missing or stale), and 1 keyless global-percentages call for `rare`. The pre-check and the transaction each read at most 200 active challenges, which is far more than the cap of 20.
- Verify: 1 read, the private-marker read, 1 Steam call, 1 achievement record write with its index patch, and 1 transaction (challenge, event and counters).
- List: one active-set query, plus one transaction per overdue challenge, plus the page.

## Tests

- `tests/qit-challenge-tracker.test.ts` (`npm test`) covers the transition table, overdue rules, input validation, the unlock rule (the second before acceptance, the acceptance second itself, unknown unlock time, and other achievements), the completion counter dimension, defensive reads, and the route: auth, listing and its parameters, issue outcomes (including `conflict` and `not_rare`) and validation, actions, pending/private/404/409 mapping, Steam 429 versus 502, same-origin checks, the body cap, and the tighter verify rate limit.
- `tests/qit-challenge-tracker.emulator.test.ts` (`npm run test:firestore`) covers:
  - issue with stored achievement data, every issue refusal, and the cap
  - one active challenge per achievement: `existing` for the same request, `conflict` for any other, both before any Steam call, and again in the transaction when issues race
  - the rare tier checked against Steam's global percentages, including a game without global stats
  - issued, accepted and completed transitions with events and counters
  - an unlock between issue and acceptance that does not count
  - `rare` completion, where an unlock completes only the challenge on that achievement
  - five racing verifies that complete once and emit one event
  - decline and every illegal transition
  - expiry by touch, by verify (without a Steam call), by list sweep and by direct sweep
  - private achievements
  - paging with a shared issue time
  - the completion event as stored

## Notes for later packages

- **Rarity is checked at issue time only.** `issueChallenge` asks Steam for global percentages on each rare issue. `qit-rare-challenge` can serve them from a shared `appAchievements` cache instead, and can pick the target for the user. A challenge keeps its tier even if the achievement's global percent later rises above it.
- **No auto-accept.** The Achievement Hunt "I'll try this" action can call `POST` and then `PATCH accept`. If one round trip matters, a later package can add an `accept` flag to issue.
- **Verify after expiry does not complete.** An unlock made inside the window but verified after `expiresAt` does not count, because the challenge expires first. A grace period would be a product decision for the streaks or hunt package.
- **Clock sources differ.** `unlocktime` comes from Steam's clock and `acceptedAt` from the server's. A skew of a few seconds only matters for an unlock in the same minute as acceptance.
