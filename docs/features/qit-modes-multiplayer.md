# Alive and Kicking and Everyone Owns It

Implements features 1, 8 and 9 through the existing roulette mode registry, scoring interface and structured reasons. No UI pages or public spin request/response changes.

| Mode | Eligibility | Weight before sampler gamma | Reason priority |
| --- | --- | --- | --- |
| Alive and Kicking | Known multiplayer flag, excluding known non-game types | High: 4; mid: 2; low, missing band or missing counter: 1 | active_now |
| Everyone Owns It | At least two distinct players, all own the game; every selected friend is present; excluding known non-game types | 1 | friends_all_own |

Alive and Kicking reads the merged store flags and live-player signals. Its live loader uses the merged player-count cache/fetcher and `liveSignalsOf`: high >= P75, low <= P25, and counts below 100 concurrent always low (D15). High wins tied quartiles as defined by the player-count package. Bands are computed together across known counts in the supplied pool, including fresh cached counts and this spin's bounded refresh results; absent and unresolved counters do not contribute to the percentiles. The scorer enforces the absolute floor even if supplied an inconsistent band. The sampler applies the shared gamma (default 1.5).

Known counts emit `active_now{players, band}`, including a known zero. A missing counter or failed/unattempted fetch emits no activity reason or badge and remains eligible at weight 1. Missing or unknown multiplayer flags cannot establish multiplayer eligibility. Everyone Owns It emits `friends_all_own{count}` including the requester. Ownership comes from owned-game libraries, never family sharing or can-play access.

## Intersection scopes

The existing friends and pair scope kinds are now registered. Both include the requester and use the merged `src/lib/group/intersect` to produce the common owned library. Requester library/store/achievement signals and hidden-playtime state are preserved. Group signals include each player's ownership and available playtime. Requester-only selections are rejected. The modes catalog offers Everyone Owns It in friends and pair scopes; lobby remains supported by the scorer but awaits its own resolver package.

An unavailable selected library (`private`, `not_found` or `error`) produces an empty pool and explicit `ScopeResult.unavailable` entries. The scope never silently drops that member and claims everyone owns a game. This policy applies to all modes using these intersection scopes. The existing spin response does not expose the unavailable entries; a later group UI package can surface them through its own flow. Empty intersections yield no card and record no roll.

Pool previews receive an optional internal `fetch: false` resolver context and read only fresh QIT indices/public-library caches, without Steam calls or writes. Missing/expired/malformed friend caches produce an unavailable member and empty pool. Actual spins use the existing social `getLibraryFor` cache and refresh behavior. Existing resolvers remain compatible with the optional context field; the internal spin resolver type now explicitly preserves its extended result fields.

## Enrichment and exclusions

Live enrichment reads at most 1,000 cache records and refreshes at most 40 games using the player-count package's five-worker concurrency and deadlines. Multiplayer candidates precede others in the bounded refresh order, followed by lifetime playtime and appid. Preview enrichment reads unexpired cached counts only. Cache/fetch failures degrade to unknown rather than failing a spin. Coverage distinguishes loaded no-counter signals from unresolved signals.

Known software, tools, DLC and other non-game types leave the standard pipeline pool automatically (D17). Both scorers also reject known non-games, including when invoked directly. Unknown store types follow the merged exclusion policy and remain possible candidates; Alive and Kicking still needs a known multiplayer flag.

## Validation and package boundary

`tests/qit-modes-multiplayer.test.ts` covers weights, reason priorities/rendering, sampling with no counter, known zero, the absolute floor, multiplayer eligibility, non-game exclusion, uniform group ownership, intersection scopes, private/failed/missing members, requester hidden playtime, cache-only previews, bounded live enrichment and an actual group spin recording every participant. Foundation/catalog tests reflect the implemented modes and newly sourced families.

No picker, Friend Night, comparison or lobby pages are included. Social library freshness and privacy behavior remain owned by the friends-data package. That package does not expose a friend's explicit hidden-playtime flag in `FriendLibrary`; this package preserves supplied requester hidden state and does not infer friend playtime privacy. A future group UI should avoid claiming zero playtime proves never played when that underlying signal is hidden. Activity comparisons are relative to available observations when bounded enrichment leaves some counters unresolved.
