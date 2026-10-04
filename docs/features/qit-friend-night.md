# Friend Night

`/friend-night` combines the requester's library with up to 16 selected Steam
friends. Authentication preserves the return path through Steam sign-in. Only
the Friend Night navigation entry is enabled by this package. The page uses no
unshipped page or lobby actions.

Load libraries shows progress and a final state for each friend: accessible
(including a genuinely empty library), private, missing profile, or temporary
failure. Unreadable players never silently leave the intersection. The requester
must explicitly remove them and reload the smaller group; private removals stay
visible in the page. A failed friends lookup can be retried. When the friends
list is private, the existing pinned-player API accepts a profile URL, Steam ID,
or vanity name and refreshes the selection list.

## Filters and results

The page offers multiplayer, co-op, achievement support, the requester's
not-recently-played window (90 days), and minimum/maximum requester playtime.
These use the merged session filter engine. Discovery options reuse the pure
group predicates: nobody played, at least one newcomer, everybody below a
configurable hours threshold (strictly below), and exactly one experienced
player with every other player at zero minutes. The veteran threshold defaults
to 10 hours. Played by everyone requires positive known playtime for every
owner. Unknown playtime does not establish a discovery condition.

Activity can be ignored when selecting, limited to games with at least 100
current players, or preferred through the merged Alive and Kicking multiplayer
mode. Ignore and active use Everyone Owns It for a uniform draw among eligible
shared games. Current activity is still enriched for the card when ignored as a
selection criterion. The shared loader calculates pool-relative bands: high at
P75 with a floor of 100 concurrent, low at P25. A missing counter has no badge.
Known player counts receive one activity reason (not duplicated when the
selected mode already emits it) alongside ownership and the
known never-played count. Individual playtime is displayed with names, Steam ID
fallbacks, and an explicit unknown/hidden state.

The merged result card and temporary-veto wrapper provide reroll, Steam store,
Not tonight, and exclusion choices. A new session ID is created on mount and
ended on unmount through the exclusions API. The merged pipeline reads those
vetoes and records successful recommendations in the existing roll/event store.
No independent sampler, intersection, event writer, Steam client, or cache is
introduced.

## API and data

`POST /api/friend-night` is a small orchestration adapter:

- `{ action: "library", steamId }` loads one player through `getLibraryFor` and
  returns only ID, state, and owned-game count, allowing individual progress.
- `{ action: "pool" | "spin", mode, scope: { kind: "friends", with: [...] },
  filters?, sessionId?, discovery?, hours?, ... }` accepts the existing
  pool/spin request fields, validates them with the shared parser, applies group
  discovery to the strict friends resolver, then calls the merged pipeline.
  The response extends the existing DTO with unavailable players and, for a
  picked game, each group member's playtime. Pool responses also have `card: null`.

Authentication, Origin/Referer validation, bounded JSON (16 KiB), standard error
envelopes, no-store responses, and per-user/per-IP limits apply to every call.
The orchestration limit allows a burst of 30 requests with 0.5/second refill;
spins additionally use the existing 10-request burst and 0.2/second refill.
Steam access remains inside merged services, including their global key budget
guard, bounded refreshes, safe error logging, and 30-minute public-library cache.

Pool previews use cached signals without Steam calls or writes. Their count can
be lower than a live spin's count when metadata or activity is missing. Unknown
filter checks are shown. An accessible group can spin even when the preview is
empty or its library cache is missing; the live resolver validates the group
again. Results and previews are invalidated when selections or filters change.

## Validation and package boundary

`tests/qit-friend-night.test.tsx` executes discovery predicates and the shared
pipeline with fixtures, including strict empty/unavailable pools, group reasons,
picked per-player playtime, and shared roll writes. Component fixtures cover
initial/empty states, per-friend partial data, all library failure states, and
individual hidden/known/never-played playtime. API tests execute authentication
and Origin refusals, body validation/caps, each library state, pool/spin success,
safe upstream failures, and per-user rate limits.

Local checks: TypeScript and lint passed, and the complete unit suite passed.
Dependency installation reported that this environment uses Node 24 while the
repository declares Node 22; the prescribed shipping pipeline remains the
delivery authority. No tracked dependency or infrastructure files were changed.

Public launch remains subject to the plan's privacy policy and delete-my-data
prerequisites. This package does not implement or deploy those sibling surfaces.
The existing social reader does not expose an explicit friend hidden-playtime
flag; the group engine preserves unknown values it receives, but zeros supplied
by that reader can still reflect Steam-hidden totals. Correcting that data
contract belongs to its owning package. Standard stored filter selections retain
the session filters; the discovery adapter's choice is not a new persisted filter
registry entry, so history does not yet replay that extra discovery option.
