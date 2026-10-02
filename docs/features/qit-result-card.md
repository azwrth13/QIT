# Enriched recommendation result card

`ResultCard` (`src/components/result-card/ResultCard.tsx`) renders one roulette pick from the `Card` DTO (`src/lib/roulette/types.ts`, built by `buildCard` in `roulette/card.ts`). It is presentational: no fetching, no routing, no picker wiring. The picker, daily, history, and lobby surfaces own the data and the actions.

## Contents

- **Art:** the store header (`card.art.header`), then the community icon on a striped tile, then a "No artwork" placeholder. A header or icon that fails to load drops to the next source. The images are decorative (`alt=""`) because the game name is the heading beside them.
- **Header:** mode label, game name (the card's accessible name), previous QIT selections, and, in multiplayer modes (`alive-and-kicking`, `everyone-owns-it`), the current players badge (feature 9).
- **Why QIT picked it:** the first three `card.reasons`, rendered through `renderReasons` in `roulette/reasons.ts`. The card never formats reason text itself. Modes and the pipeline already order reasons by priority.
- **Stats:** playtime, last played, achievement percent with unlocked/total and a bar, and current players in other modes. Unknown values have their own text: last played is "Unknown" for a played game without a timestamp, achievements show "No achievement data" when the DTO has none, and players show "No live player count" when the app has no counter. None of these renders as zero.
- **Activity band (D15):** the band comes from `live.band`, computed by `activityBand` in `apps/live-players.ts`. Only `high` and `low` get a label. `mid` shows the count alone, and no counter shows no badge.
- **Friends:** owners, players who have played it, and players who never have, from `card.friends`. The section is hidden when `friends` is null (solo picks; `buildCard` currently always sends null until a group UI package resolves player names). Players without an avatar get a letter monogram.
- **Last played** uses 30-day months, like the modes' `idle` and `rediscovery` reasons, so the stat and the reason agree.

## Actions

`onPlay`, `onReroll`, `onNotTonight`, `onViewOnSteam`, and `onExclude` each receive the card. An action without a handler is not rendered, and the row is omitted when no handlers are passed. "Play this" is a link to `card.launchUrl` and "View on Steam" opens `card.storeUrl` in a new tab, so both still work as links while the handler records the action. The exclusion scope belongs to the exclusions surface, so the card only reports the click. `busyAction` disables every action while one is in flight and marks that one `aria-busy`.

Pass `now` (Unix seconds) from the owning surface so the "last played" text is stable between the server and the client render.

## Fixtures

`/fixtures/result-card` renders every state from `src/components/result-card/fixtures.ts`. Add `?only=<id>` to show one state. The route returns 404 in production unless `QIT_FIXTURES=1` is set. The fixtures cover full data, missing art (icon fallback), no art, no achievements, no player counter, high, low, and no activity band, friends present and absent, many previous selections, partial and missing handlers, and a busy reroll. The fixtures use real Steam header and icon URLs. Player names are invented and have no avatars.

## Verification

`tests/qit-result-card.test.tsx` server-renders the card the same way the streak widget test does. It covers the formatting helpers, top-three reason order through the shared renderer, art fallback, decorative alt text, unknown versus zero for each stat, the band rules, multiplayer placement, the friends section, previous selections, action visibility, link targets, and the busy state.
