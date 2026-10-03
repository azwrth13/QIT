# Steam friend dashboard

`/friends` is enabled for signed-in users. It focuses on discovering games to play together: avatars,
Steam display names, available status/current-game information, shared-game counts, and recent games.
Search is by name or Steam ID; pagination mounts at most 14 cards. An IntersectionObserver with no
prefetch margin starts the shared count only when a mounted card enters the viewport. Browsers without
IntersectionObserver can use the explicit Load shared count button. Recent activity is requested only
on expansion and reused while the card stays mounted.

## Actions

- Find games we both own refreshes only the selected player's cached library, shows the ownership
  intersection with that friend's individual playtime, and calls `/api/roulette/pool` with `pair` scope
  to show how many games remain eligible after roulette exclusions and game filters.
- Start a roulette calls `/api/roulette/spin` with `pure-random` mode and `pair` scope. The result appears
  directly in the card with Steam store and launch links, including an explicit empty-result message.
- Compare libraries links to `/compare/<id>` only when `isNavEnabled('compare')` is true.
- Add to Friend Night links through foundation's `withHref`/`parseWithParam` contract, preserving the
  current URL selection and adding the card's player. It stays hidden until Friend Night is enabled.
- Private friends lists expose the existing pinned-player POST/DELETE flow, accepting profile URLs,
  17-digit IDs, or vanity names. Pinned cards can be removed. Pinning does not bypass private game details.

## Data and guards

`POST /api/steam/friends/details` accepts one `{ steamId, kind: 'shared' | 'recent', includeGames?: boolean }`.
It requires a session, same-origin request, bounded JSON, and an accessible player in the requester's
cached friend/pinned result. A per-user bucket permits a burst of 30 lookups and refills at one every two
seconds; a per-IP bucket permits 120 and refills at two per second. Responses are `private, no-store`.
Invalid, forbidden and unavailable responses use the existing route error envelope.

Shared counts reuse friends-data's public-library cache (30 minutes), read the owner's compact index,
and use group-intersection. Count requests return no game list; explicit discovery requests return only
the intersection. An unsynced index asks the user to sync the Library page. Private, missing and failed
libraries are states with explanations, never zero counts. Private games disable discovery actions.

Recent activity uses the existing typed `GetRecentlyPlayedGames` endpoint, capped at five games.
`publicRecentPlays/<steamId>` stores the small typed result plus a Firestore Timestamp `expiresAt`:
public results expire after ten minutes, private results after five. Readers enforce expiry without
requiring a Firestore TTL policy. Concurrent expansions share one request on each instance. Cache
failures are best effort, and Steam failures produce a retryable message rather than false empty data.

Dashboard detail calls inject a Steam client with the existing Firestore-backed daily budget guard,
reserving against `steamBudget/<UTC date>` with its default 90,000-call daily ceiling. Both the friend
verification refresh and game requests use that client. The client retains existing retry/concurrency
limits. Cached library and recent data remain reusable when fresh; cache misses can be unavailable when
the budget is exhausted. No privacy setting is bypassed. The page discloses public data and cache retention.

## Validation

React interaction tests (jsdom) cover public/private/pinned cards, visible versus off-screen loading,
14-card pagination without eager library fetches, recent expansion/reuse, sign-in, action wiring,
unshipped-route hiding, and selection handoff. Route tests cover authentication, Origin checks,
validation, player membership (including pinned fallback), private states and per-user rate limits.
Data tests cover strict intersection, individual playtime, unsynced-owner messaging, cache expiry,
private cached recent data, and request coalescing. Existing nav tests now include the shipped Friends entry.

## Package-boundary notes

- Compare and Friend Night remain unshipped and hidden; this package flips only the Friends nav flag.
- The existing process-wide Steam client is budget-capable but unconfigured by default. The new details
  route injects a guarded client; attaching it to unrelated legacy/social/spin requests is outside this package.
- Steam status may be absent or reflect the existing fifteen-minute friend snapshot. Missing status is
  labelled unavailable. Steam may hide individual playtime independently; QIT does not infer missing time.
- Recent-cache expiry is enforced on reads. Physical deletion of expired documents requires an optional
  Firestore TTL policy on `publicRecentPlays.expiresAt`, configured at deployment rather than here.

Local verification: 649 unit tests pass across 34 files; lint, typecheck, production build, and
`npm audit --omit=dev --audit-level=high` pass. The local runtime is Node 24.21.0; the existing CI uses
Node 22. No live Steam credentials or browser session were used; API interactions use fixtures.
