# Backlog Discovery view

`/backlog` is a dedicated surface for discovering and reviving forgotten or unused games in the user's Steam library (feature 12 of the QIT 20-feature plan). Its navigation entry in `src/app/navbar/nav-items.ts` is enabled in this package. Anonymous visitors see an invitation to sign in with Steam; backlog data and category spins are fetched only for authenticated sessions.

## Categories and thresholds

The page provides six category tabs with live counts, reflecting the tunable defaults from plan section 2.4 and captain decision D5 (defined in `src/lib/roulette/thresholds.ts` and evaluated via `src/lib/library/backlog.ts`):

| Category ID | Tab label | Description and threshold rules | Default mode on spin |
| --- | --- | --- | --- |
| `never-played` | Never played | Games owned with `playtimeForever === 0`. | `dust-collector` |
| `barely-played` | Barely played | Games with `0 < playtimeForever < 120` minutes (Steam refund window). | `dust-collector` |
| `not-played-in-a-long-time` | Not played in a long time | Games not launched in strictly more than 90 days, with 0 minutes in the last 2 weeks. | `dust-collector` |
| `started-but-abandoned` | Started but abandoned | Playtime between 30 and 600 minutes, untouched for at least 90 days. | `dust-collector` |
| `low-completion` | Low achievement completion | Games with achievements where unlocked is strictly less than 60% of total. | `achievement-hunter` |
| `high-completion-but-unfinished` | High achievement completion | Games where unlocked is at least 80% and strictly under 100% of total. | `finish-something` |

Categories may overlap (for example, a game can be both barely played and idle for 90+ days). Non-game store items (applications, software, DLC, tools) are excluded from all backlog categories. 100% completed games are excluded from achievement backlog categories.

## Graceful degradation

1. **Achievement categories ("Scan to unlock"):**
   - When no achievements have been scanned for the library, achievement category tabs display a `Scan` badge and state `scan_required`.
   - The category workspace presents a "Scan achievements to unlock" prompt.
   - Clicking scan initiates incremental scanning in the client against `POST /api/achievements/scan` in batches, displaying a live progress bar. Once completed, backlog counts automatically update.
   - Private Steam achievement settings are surfaced with instructions to make Game details public.
   - Partially scanned libraries display the count of discovered matching games alongside a note showing how many games remain unscanned, with a button to scan remaining games.

2. **Hidden playtime:**
   - When Steam privacy hides total playtime, playtime-based categories enter `playtime_hidden` status.
   - The workspace informs the user that playtime is private and explains how to adjust Steam privacy settings, while keeping achievement categories accessible.

3. **Empty library:**
   - When no games are synced or the index is unbuilt, the page prompts the user to visit `/library` to sync their games.

## Category spinning and roll recording

Users can spin within any active backlog category via `POST /api/backlog/spin`:
- The backend evaluates the candidate pool for the selected category using `BACKLOG_CATEGORIES`.
- Active user exclusions (session, day, 7-day, permanent) from `users/{id}/prefs/exclusions` and request `exclude` IDs (prior picks from the same session) are filtered out before drawing.
- The sampler draws an eligible candidate using weighted selection and seedable PRNG (`createRng`), supporting deterministic replays.
- Category-appropriate structured reasons are assigned (e.g., `never_launched`, `barely_played`, `idle`, `ach_remaining`, `ach_near_complete`).
- The spin is recorded as a roll in `users/{id}/rolls/{rollId}` with the appropriate `modeId` (`dust-collector`, `achievement-hunter`, or `finish-something`), capturing playtime at roll time for played-detection.
- Header art is loaded via `getAppMeta` / `appArtUrl`.
- The pick is rendered in the UI with `ExcludableResultCard`:
  - **Play:** records acceptance via `PATCH /api/history` and launches the game via `steam://run/<appid>`.
  - **Reroll:** records reroll transition in history and triggers a category re-spin excluding previous session results.
  - **Not tonight / Exclude:** integrates with the vetoes API (`POST /api/user/exclusions`), hiding the game for the day, session, 7 days, or permanently.

## API routes

- `GET /api/backlog`: Authenticated read endpoint with rate limits (`30/s user, 120/s ip`), returning `BacklogOverview` with categories, game summaries, counts, and scan/privacy states. Responds with `Cache-Control: private, no-store`.
- `POST /api/backlog/spin`: Authenticated mutation endpoint with same-origin validation (`checkSameOrigin`), rate limits (`20/s user, 60/s ip`), and body schema validation. Responds with `BacklogSpinResponse` containing the `Card` DTO.

## Tests

- Service tests (`tests/qit-backlog-view.service.test.ts`):
  - Accurate categorization across all 6 backlog categories.
  - Non-game exclusion.
  - Degradation states: `playtime_hidden` and `scan_required`.
  - Spin resolution, reason construction, mode mapping, exclusion filtering, deterministic seeding, and empty pool handling.
- Route tests (`tests/qit-backlog-view.routes.test.ts`):
  - Authentication checks (401 for anonymous calls).
  - Origin check enforcement on POST (403 for cross-origin).
  - Input validation (400 for invalid category, malformed exclude/sessionId).
  - Safe error handling (502 envelope).
  - Rate limiting (429 response with Retry-After).
  - Navigation enablement and auth gating in `nav-items.ts`.
- Component tests (`tests/qit-backlog-view.test.tsx`):
  - `BacklogPage` auth gating (sign-in link vs view).
  - `BacklogView` states: loading, error with retry, empty library, tabs with counts, scan callout, playtime hidden banner, and rendered result card.
- Foundation navigation tests (`tests/qit-foundation.test.ts`):
  - Updated to reflect the enabled `backlog` item.

## Package boundary

No short-link, `next.config.ts`, `firebase.json`, `apphosting.yaml`, or `README.md` files were edited. Only `backlog` was enabled in `nav-items.ts`.
