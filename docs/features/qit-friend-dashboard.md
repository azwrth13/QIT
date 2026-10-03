# Steam friend dashboard

`/friends` is enabled for signed-in users. It focuses on discovering games to play together: avatars,
Steam display names, available status/current-game information, shared-game counts, and recent games.
Pagination mounts at most 14 cards. An IntersectionObserver with no
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

Recent activity calls the existing typed `GetRecentlyPlayedGames` endpoint directly, capped at five games.
It is not persisted; the card keeps the result while it stays mounted, so one expansion makes one Steam
call. Steam failures produce a retryable message rather than false empty data.

All dashboard Steam calls use the shared process-wide client from `getSteamClient`, with its existing
retry and concurrency limits and whatever global budget is attached to it. No privacy setting is
bypassed. The page discloses public data and cache retention.

## Validation

React interaction tests (jsdom) cover public/private/pinned cards, visible versus off-screen loading,
14-card pagination without eager library fetches, recent expansion/reuse, sign-in, action wiring,
unshipped-route hiding, and selection handoff. Route tests cover authentication, Origin checks,
validation, player membership (including pinned fallback), private states and per-user rate limits.
Data tests cover strict intersection, individual playtime, unsynced-owner messaging, and public and
private recent activity. Existing nav tests now include the shipped Friends entry.

## Package-boundary notes

- Compare and Friend Night remain unshipped and hidden; this package flips only the Friends nav flag.
- Steam status may be absent or reflect the existing fifteen-minute friend snapshot. Missing status is
  labelled unavailable. Steam may hide individual playtime independently; QIT does not infer missing time.

Local verification: unit tests, lint, typecheck, production build, and
`npm audit --omit=dev --audit-level=high` pass. The local runtime is Node 24.21.0; the existing CI uses
Node 22. No live Steam credentials or browser session were used; API interactions use fixtures.
