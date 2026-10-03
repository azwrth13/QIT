# Temporary vetoes and hidden games (feature 14)

The four choices are Not tonight (`day`), Hide for this session (`session`),
Hide for 7 days (`7d`), and Don't recommend again (`forever`).

## API

`GET /api/user/exclusions` returns `{ exclusions }`: the authenticated user's
current hides, including hides belonging to other sessions. Each entry has
`appid`, `scope`, `until` (ISO date or null), `sessionId` (string or null), and
`at`. Responses are private and no-store.

`POST /api/user/exclusions` accepts one of:

- `{ action: "hide", appid, scope, sessionId? }` → `{ exclusion }`.
- `{ action: "unhide", appid }` → `{ removed: boolean }`.
- `{ action: "end-session", sessionId }` → `{ removed: number }`.

Every POST checks authentication and same Origin through the shared guards
(the guard permits a same-origin Referer fallback), bounds the body to 1 KiB,
and rate limits by user and IP. GET is also rate limited. Limits use the
existing per-instance token buckets: 60 requests per user, refill 1/second;
120 per IP, refill 2/second. Requests never choose a target user.

Not tonight reads the validated IANA timezone from the stored profile. A missing
zone returns 400; the client captures the browser zone using the existing
profile PATCH before submitting, which preserves any valid stored zone.
Expiry is the first instant of the next local date, including DST changes.
Seven-day hides last exactly seven elapsed 24-hour periods. Readers ignore
expired entries immediately; cleanup jobs are unnecessary.

Session hides require the owning picker/lobby session id. They apply only when
the filter pipeline reads with that id. New session entries have no clock
deadline; the owning surface must call end-session when ending that session
and use a new id for a new session. Old entries with the former twelve-hour
deadline remain readable under their existing deadline. Changing the session
id stops old session hides from affecting recommendations even if an
end-session request cannot be delivered. Management still lists those entries
so they can be un-hidden. This package does not create lobby-wide vetoes.

Repeating a live hide with the same scope and session id is a no-op: it preserves
the original timestamp and deadline and writes no duplicate event. Changing
scope replaces the existing choice, except a permanent hide must first be
un-hidden. Repeating un-hide or end-session is also a no-op. All writes remain
transactional through the merged exclusions store, with the existing
1,000-entry cap and events/counters.

## UI and integration

`/hidden-games` is linked from the authenticated library controls. It groups
current hides by scope, displays library names (appid fallback for games no
longer in the library), and offers Un-hide. The library selector renders the
merged result card with working Not tonight and Add to exclusions actions.
No navbar flags or card design were changed.

`ExcludableResultCard` wraps the existing card, saves Not tonight through the
API, and opens a scope chooser for Add to exclusions. Owning surfaces provide
`sessionId` and can refresh their pool through `onExcluded`. Session hide is
disabled when no session id is provided. `updateExclusion` is the shared client
for hide/un-hide/end-session calls.

The management page has no session of its own, so its card disables Hide for
this session; it still lists and un-hides session entries. Session hides are
keyed only to picker and lobby session ids. Future picker and lobby surfaces
must supply their own ids and call end-session at their lifecycle boundary.

The merged roulette history loader already reads active exclusions with the
request session id before the filter engine's exclusion stage. No additional
cleanup or filter-engine changes are needed.

## Verification and package boundary

The emulator suite executes the API against Firestore and verifies stored-profile
timezone at the Los Angeles spring-forward boundary, exact day/seven-day expiry,
permanent persistence, sessions lasting beyond twelve hours, session mismatch
and ending, all four scopes through the exclusion stage, management reads,
un-hide, idempotent repeats and event counts, malformed inputs, authentication,
Origin refusals, and per-user rate limiting.

The existing client-side RandomGamePicker is still the legacy picker and does
not consume the server exclusion stage; migrating it belongs to picker-shell.
Lobby-wide exclusion propagation belongs to lobby-roulette. No other
surface's feature flag is enabled here.

Local validation: typecheck and lint passed; all 637 unit tests passed, and
21 emulator tests passed across this package, event-store, and spin-api. The
emulator used a demo project and isolated ports with a temporary config; the
tracked Firebase configuration was not changed.
