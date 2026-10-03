# Game Night Lobby core

Feature 3 core: Steam-authenticated creation and joining, member states, a cached
common library, host-owned shared filters, and short polling. Roulette, vetoes,
reroll voting, and Call it a night belong to `qit-lobby-roulette`.

## HTTP interface

All endpoints require the existing Steam session. Every mutation checks the
configured same origin. Responses use `Cache-Control: private, no-store` and the
guard error envelope `{ error: { code, message } }`.

| Endpoint | Behavior |
| --- | --- |
| `POST /api/lobby` | Creates a lobby with the caller as host; returns HTTP 201 `{ lobby, url }`. Share URL uses `getBaseUrl(req)`. No body required. |
| `POST /api/lobby/:code/join` | Joins as the signed-in caller. Rejoining is idempotent. No body required. |
| `DELETE /api/lobby/:code` | Leaves as the caller. Leaving twice is idempotent. |
| `PATCH /api/lobby/:code` | Exactly one of `{ state: "present" \| "ready" \| "away" }` or `{ filters: FilterSelection[] }`. Members change their own state; only the host edits filters. Bodies are capped at 8 KiB. |
| `GET /api/lobby/:code?since=<version>` | One parent-document read on normal polls. Returns `{ lobby }` when changed, or HTTP 304 with no body when unchanged. Expiry is observed before comparing versions. `since` is optional and must be a nonnegative safe integer. |

`lobby` carries the code, host ID, version, status, expiry in milliseconds, shared
filters, member names/avatars/states/library states, common game count, filtered
count, and the count excluded because a filter needed unknown data. Signed-in
visitors possessing the code can inspect the member list before joining. Polling
does not return complete member libraries or common-game payloads.

## Transactions and data

`lobbies/{code}` is the authoritative versioned document. Creation starts at
version 1; joining, leaving, member-state edits, host-filter edits, and expiry
each increment the version in a Firestore transaction. Idempotent join/leave
requests do not increment it. Successful active-lobby mutations refresh the six-hour idle deadline;
polls do not. At the deadline, a reader or mutation transaction marks the lobby
expired and increments once. Attempts to mutate an ended lobby return HTTP 410;
account deletion is the exception and also removes members from ended lobbies
(see [qit-privacy-data-controls.md](qit-privacy-data-controls.md)).
An expired lobby remains readable as an ended snapshot. When the last member
leaves the lobby closes. The member list is ordered by join time (Steam ID breaks
ties); when the host leaves, the earliest remaining joiner becomes host.

Codes are six cryptographically random characters from
`23456789ABCDEFGHJKMNPQRSTUVWXYZ` (31 symbols). Lowercase input is normalized.
Creation collision-checks the code within the creation transaction and retries
up to ten codes without consuming extra creation tokens. Existing documents,
including expired ones, are never overwritten.

Common libraries use the merged `getLibraryFor` and `intersect`. Unreadable
libraries are excluded with explicit per-member `private`, `not_found`, or
`error` states; readable members still contribute. With no readable libraries
the common set is empty. Hidden playtime is detected using the merged library
model and kept unknown in the group signals.

Library loading happens outside Firestore transactions. Membership commits
compare the version used to compute the common set and retry when it changed.
This prevents a concurrent join or leave from publishing an intersection based
on stale membership. There are up to twelve membership retries, with HTTP 409
and a retry message when contention persists.

`lobbies/{code}/common/{n}` contains cached candidates serialized as compressed
JSON strings (`deflate-v1:` plus base64). Each chunk decompresses to at most
700,000 bytes; even incompressible data fits below the document limit after base64.
There is a 4 MB total stored bound and a 200-chunk bound to leave room for replacing
the previous set within Firestore's transaction request/write limits. This avoids thousands
of automatic nested index entries. Only successful membership changes rebuild
this cache. Polling and member-state edits never read the chunks; host-filter
edits read them in the same transaction and run the merged filter engine.

Filters combine with AND and unknown signals exclude a game with a reported
count. Playtime and recency session filters refer to the host's cached library;
group filters receive every member ID, including unavailable members. If the
host's library/playtime is unavailable, library filters return an unknown count
rather than matching another member's playtime. Store and achievement signals
already in the library index are reused. Live/history enrichment and fresh
store fetches are outside this package; filters requiring absent signals show
unknown coverage. Filtering does not refresh Steam libraries.

Rate limits use transactional token buckets in `lobbyLimits/{kind}-{sha256}`:

- Creation: per Steam user, burst of three, refill three per hour.
- Join attempts: per trusted-proxy-derived IP, burst of twenty, refill twenty per
  minute. Attempts include invalid, full, expired, and repeated join requests.

The limits are shared across instances and cold starts. Raw IP addresses are not
stored. HTTP 429 includes `Retry-After`. Bucket timestamps and expiry are real
Firestore timestamps; exhausted requests do not write the bucket.

No Firestore rules or indexes changed: Admin SDK access remains server-only,
and no queries or composite indexes were added. No TTL policy is required for
correctness. If operators enable parent-document TTL later, child common docs
need separate cleanup because Firestore does not delete subcollections with a
parent. Child chunks deliberately have no independent TTL deadline that could
remove an active lobby's cache after an idle-deadline extension. Expired data
cleanup and rate-limit bucket cleanup are operational follow-up notes.

## Minimal pages

`/lobby` provides create and code-entry actions. `/lobby/[code]` renders a Steam
sign-in link with the existing validated `next=/lobby/<code>` return flow for
signed-out visitors. Signed-in visitors see the member list, common and filtered
counts, join/leave and present/ready/away controls. The host has a minimal
never-played filter checkbox; the API supports all registered filter selections.
The navigation flag stays disabled until the later lobby roulette/navigation
rollout packages.

The client polls every 2 seconds when visible and every 8 seconds when hidden,
starting immediately and on return to a visible tab. It uses sequential requests,
aborts on unmount, treats HTTP 304 as unchanged, and ignores responses older
than the latest mutation response. Poll failures display a message and retry;
a successful poll clears only its own error, so mutation failures stay visible
until the next mutation attempt.
Library data stays cached until membership next changes.

## Validation

`tests/qit-lobby-core.emulator.test.ts` exercises creation, real QIT library-index
integration, join/leave, automatic host transfer, closing, member states, host
filter enforcement, versioned polls, the one-read no-change path, expiry after
the last mutation, committing expiry on a refused mutation, simultaneous joins,
the last-slot race, ninth-member refusal, private/error libraries, hidden
playtime, code collisions, persistent rate limits and simultaneous limiter
consumption, and an 8,000-game chunked cache with all eight members.

`tests/qit-lobby-core.routes.test.ts` exercises auth and origin checks on every
endpoint, configured share links, trusted IP forwarding, HTTP 429 and retry
headers, empty HTTP 304, version validation, edit shape/body limits, delegation
to the authenticated caller, and safe error responses. Existing auth-next tests
cover the OpenID return path end to end.

For an isolated local emulator run, use a temporary configuration with dedicated
ports and a demo project; do not reuse another lane's emulator. Standard CI
discovers both suites through the existing Vitest projects.

Local checks: lint, typecheck, all 514 unit tests, all 64 emulator tests, and a
production build. The full emulator suite passed with `--maxWorkers=1
--testTimeout=20000` on the isolated demo project. An initial parallel run beside
the build hit the existing spin suite's default five-second timeout; the
serialized run passed every test.
