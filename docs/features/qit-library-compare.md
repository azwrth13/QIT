# Library comparison page and API

`/compare/[steamid]` is a signed-in surface for comparing the authenticated user's Steam library with another Steam player (feature 11 of the QIT plan). `/compare` provides an entry picker to enter a 17-digit Steam ID, profile URL, or custom vanity name, or pick from the user's Steam friends. The `compare` navigation entry in `src/app/navbar/nav-items.ts` is enabled in this package (`enabled: true`, `inNavbar: false`).

## Features and Display

The page and API present the full comparison breakdown:
- **Games both users own (`both`)**: Common games owned by both accounts.
- **Games only User A owns (`onlyMe` / `onlyA`)**: Games in the requester's library not owned by the friend.
- **Games only User B owns (`onlyThem` / `onlyB`)**: Games in the friend's library not owned by the requester.
- **Number of shared games (`sharedCount`)**: Total count of games owned by both users.
- **Shared games neither player has recently played (`neitherRecentlyPlayed`)**: Shared games where both players have zero playtime or were inactive beyond the recency threshold (defaulting to 90 days from `THRESHOLDS.notRecentlyPlayedDays`).
- **Shared games one player has never played (`oneNeverPlayed`)**: Shared games where at least one player has recorded zero minutes of playtime.
- **Individual friend playtime (Decision D10)**: Displays individual playtimes for both the requester and the friend on shared and exclusive games, formatting hours and minutes, or marking "Never launched" (0 minutes) and "Hidden" when playtime is kept private.
- **Spin the shared games button**: A prominent action using roulette scope `pair` and mode `everyone-owns-it` to draw from the shared game pool. When a roll succeeds, it displays the enriched `ExcludableResultCard` with full artwork, reasons, and actions (Play this, Reroll, Not tonight, View on Steam, Add to exclusions).

## API Endpoints

- `GET /api/compare/[steamid]` and `POST /api/compare/[steamid]`: Dynamic route returning `CompareResult`.
- `GET /api/compare?steamid=...` and `POST /api/compare`: Query/body fallback routes.

### Route Guards and Safety
- **Authentication**: `getSteamId()` ensures only authenticated Steam users can compare libraries (401 unauthenticated).
- **Origin verification**: `checkSameOrigin(req)` rejects cross-origin POST mutations (403 forbidden).
- **Rate limiting**: Token bucket limits (burst capacity 20, 1/3 refill/s per user; capacity 60, 1 refill/s per IP) return 429 with `Retry-After`.
- **Privacy & profile validation**:
  - Rejects comparing with oneself (400 invalid).
  - Rejects malformed Steam IDs (400 invalid).
  - Private profiles return 403 forbidden with user-facing guidance to set Steam Game details to Public.
  - Missing profiles return 404 not found.
  - Upstream Steam failures return 502 unavailable.
- **Cache control**: Responses include `Cache-Control: private, no-store`.

## Data Architecture & Integration

- **Requester Library**: Read from the compact 4-chunk library index (`readLibIndex`), falling back to stored per-game documents or live Steam sync if the index is not yet built.
- **Target Library**: Fetched via `getLibraryFor(ids)`, utilizing the 30-minute Firestore cache in `publicLibraries/{steamId}` (Decision D10) so subsequent comparisons do not re-query Steam.
- **Hidden playtime**: For both players, `playtimeHidden` is true when the stored user flag is set or when the fetched games all report zero playtime (same detection as library sync), so a non-QIT friend with hidden playtime shows "Hidden" instead of 0 minutes.
- **Pure Comparison**: Driven by `compareLibraries` in `src/lib/group/libraries.ts`.
- **Roulette Integration**: Spins invoke `POST /api/roulette/spin` with `{ mode: 'everyone-owns-it', scope: { kind: 'pair', with: targetSteamId } }`.
- **Navigation Guard**: Links to pending surfaces (`/friends`, `/friend-night`) use `isNavEnabled` and remain hidden until those packages ship.

## Validation

- `tests/qit-library-compare.service.test.ts`: Unit tests for comparison calculations, recency windows, never-played subsets, empty libraries, hidden playtime flags, and error taxonomies.
- `tests/qit-library-compare.routes.test.ts`: Route tests covering authentication, parameter validation, rate limits, Origin checks, 401/403/404/502 error envelopes, and `Cache-Control` headers.
- `tests/qit-library-compare.view.test.tsx`: Component tests for `CompareClient`, `ComparePickerClient`, and server page wrappers for authenticated, unauthenticated, loading, error, and loaded states.
- `tests/qit-foundation.test.ts`: Verification of `compare` enabled in `nav-items.ts`.
