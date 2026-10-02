# Achievement Hunter and Finish Something

Features 1, 4, 8 and 16 register through the existing roulette mode registry. Both modes require `library` and `achievements`, support `library` and `appids` scopes, and return structured reasons through the existing renderer. No spin request or response change is required.

## Eligibility and weights

Both modes exclude missing or null achievement summaries, games with zero achievements, completed games, and malformed counts or percentages. Achievement Hunter accepts any unfinished achievement game, including 0% completion. Finish Something accepts unfinished games at or above `finishSomethingPreferPercent` (default 60%). These are achievement completion signals, not proof of story completion or estimates of achievement difficulty.

Achievement Hunter starts at weight 1, adds 2 for at least `manyRemainingLocked` (25) achievements remaining, adds 2 at `closeToCompletePercent` (80%), and adds 1 for an abandoned game. Abandoned uses the shared `started-but-abandoned` backlog rule: playtime from `abandonedMinMinutes` (30) to `abandonedMaxMinutes` (600) inclusive, no two-week playtime, and a known last session at least `abandonedIdleDays` (90) ago. Its reason priority is `ach_remaining`, `ach_near_complete`, then `idle`.

Finish Something starts at `1 + percent / 100`, adds 2 at `closeToCompletePercent` (80%), adds 2 for at most `finishSomethingFewRemaining` (5) remaining achievements, adds up to 1 for existing playtime (`minutes / abandonedMaxMinutes`, capped at 1), and adds 1 for recent previous activity. Recent means positive two-week playtime or a known last session within `recentRotationDays` (30) inclusive. Unknown or future session times receive no recency bonus. Its reason priority is `ach_near_complete`, then `ach_remaining`; the near-completion reason appears only at the 80% threshold. A 91% game emits “You're already 91% through the achievements in this game (9 to go)” when 9 achievements remain.

Eligibility and bonus thresholds live in `src/lib/roulette/thresholds.ts` and come through `ScoreContext.thresholds` (D5). The shared sampler applies its existing gamma to these weights.

## Partial coverage and scanning

The library scope already reads `ap` (percent), `au` (unlocked), and `at` (total) from the compact library index written by achievements-data. No per-game reads or Steam calls are added by these modes. Missing achievement summary fields remain `undefined` (unscanned); `at: 0` becomes `null` (scanned, no achievements). Both are excluded, but only unscanned games reduce the existing `coverage.achievements` share. For example, one unscanned game, one no-achievement game, one completed game and one unfinished game report coverage 0.75 and one eligible game. Coverage measures indexed data, not mode eligibility.

The existing `POST /api/achievements/scan` cursor flow owns D13: the future picker offers an on-demand scan with a progress bar when an achievement mode is first used, then repeats that flow to refresh records by TTL. Achievements-data already uses 24 hours for unfinished games, 30 days for completed games and 7 days for no-stats answers. These modes consume the latest indexed summary without enforcing TTL or triggering a scan during a spin. All-unscanned pools return no card, zero eligible games and zero achievement coverage.

The pipeline passes the scope's `playtimeHidden` flag into the scoring context for spins and pool previews. Hidden playtime suppresses investment, recency and abandonment bonuses without excluding achievement-eligible games or producing playtime reasons. Missing playtime or recency likewise contributes no bonus.

## Validation and package boundary

`tests/qit-modes-achievement.test.ts` covers eligibility, malformed and complete summaries, threshold edges, weight bonuses, supplied tuning, reason priority and rendering, and hidden playtime. `tests/qit-spin-api.test.ts` covers indexed partial coverage, all-unscanned pools, unchanged card enrichment, and propagation of hidden playtime during spins and previews. The foundation registry test recognizes the two implemented modes.

No UI pages are added. Scan buttons, progress bars and client refresh scheduling belong to the later picker and Achievement Hunt packages. Group achievement semantics are left to group scopes; these modes currently declare only personal-library and explicit-appid scopes. The playtime modes remain stubs in this checkout, so their later package may extend shared scoring context independently.
