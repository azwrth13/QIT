# QIT recommendation history with re-roll

Delivers the **QIT History page with re-roll** package (Feature 13 "Game History / QIT History" and Feature 19 "Result Card Enrichment" of the QIT 20-feature plan).

`/history` is a signed-in-only surface for reviewing past recommendations, seeing which recommended games were eventually played, configuring the anti-repeat window, and re-rolling recommendations from previous sessions. Its navigation entry in `src/app/navbar/nav-items.ts` is enabled in this package.

## Features delivered

### Feature 13: Game History / QIT History
- **Tracked data per recommendation**:
  - Game artwork, title, and Steam App ID
  - Date and time selected
  - Roulette mode label (Pure Random, Dust Collector, Comfort Pick, etc.)
  - Decision state (Accepted, Rerolled, Recommended) with timestamps
  - Played state (auto-detected via library sync or manually confirmed) with timestamps
  - Friend Night participants count and IDs when applicable
  - "Why QIT picked it" selection reasons
  - Recorded playtime at recommendation
- **User capabilities**:
  - **View previous recommendations**: paginated history list (newest first) with empty, loading, error, and partial data states.
  - **Recommendations that became played games view**: dedicated tab filtering recommendations that have been played. Tab counts are labelled "loaded" because they cover only the pages fetched so far.
  - **Mark as played action**: manual confirmation button ("Mark as played") for unplayed recommendations, calling `PATCH /api/history { rollId, action: 'played' }`.
  - **Re-roll from old sessions**: re-rolls using the stored mode, filters, and scope of an earlier recommendation, keeping any stored `exclude-rolled` filter and adding the active anti-repeat setting only when the stored session had none and the setting is on.
  - **Avoid recent recommendations setting (Decision D6)**: user-configurable anti-repeat window with options Off (0), 7 days, 30 days (default), and 90 days, saved per user in Firestore.

### Feature 19: Result Card Enrichment
- Re-rolling from an old session upgrades the result into an active enriched recommendation card rendered with `ExcludableResultCard` (`ResultCard`):
  - Store header art (with icon fallback)
  - Game title and mode badge
  - Top 3 structured selection reasons
  - User playtime and last played
  - Achievement percent and unlocked/total
  - Current live players count and activity band
  - Previous QIT selections counter
  - Actions:
    - **Play this**: launches game via `steam://run/<appid>` and records roll acceptance via `PATCH /api/history`
    - **Reroll**: draws another recommendation with the same session settings
    - **Not tonight**: hides the game for the rest of the day (Decision D8)
    - **View on Steam**: opens store page in a new tab
    - **Add to exclusions**: opens duration chooser (session, day, 7d, forever) with link to manage hidden games

## API endpoints

### `GET /api/history/anti-repeat`
- Authenticates through `getSteamId`.
- Applies rate limits (30 capacity, 1/s refill).
- Returns private, no-store JSON: `{ days: number, options: [0, 7, 30, 90], defaultDays: 30 }`.
- Reads from `users/{steamId}/prefs/antiRepeat`. If unconfigured, returns default 30 days.

### `POST /api/history/anti-repeat`
- Authenticates through `getSteamId`.
- Verifies same-origin request (`checkSameOrigin`).
- Applies rate limits (10 capacity, 0.2/s refill).
- Request body: `{ days: number }`, strictly validated to one of `[0, 7, 30, 90]`.
- Persists preference in `users/{steamId}/prefs/antiRepeat`.
- Returns `{ days: number }`.

### `GET /api/history` & `PATCH /api/history`
- Consumed by `HistoryView` for paginated rolls and state transitions (accept, reroll, played).

## Security and route patterns
- All state-changing POST/PATCH requests require valid session authentication and same-origin verification.
- Per-user and per-IP token bucket rate limiting on all endpoints.
- Safe logging via `logServerError`: no URLs, keys, or sensitive payload details leaked in logs or error envelopes.
- Private `Cache-Control: private, no-store` on authenticated API responses.

## Package boundaries and notes
- Unshipped surfaces (e.g. `/friend-night`, `/lobby`) remain hidden behind `isNavEnabled` checks.
- Auth routes, short-link files, `next.config.ts`, `firebase.json`, `apphosting.yaml`, and `README.md` remain untouched.
- Anti-repeat settings are stored under the user's `prefs` subcollection, keeping isolation from other user data.
- The anti-repeat preference (D6) is applied only to re-rolls from `/history`. Applying it at the shared spin boundary so every roulette caller honors it is a follow-up.
