# Playtime modes and backlog categories

Implements features 1, 8, 12 (category logic only), and 17. The four existing registry entries now score through the roulette core and are automatically offered by the mode catalog. No spin request or response contract changes. Each mode requires only library signals; no network or database access occurs in its scorer.

| Mode | Eligibility | Weight before sampler gamma | Reason priority |
| --- | --- | --- | --- |
| Dust Collector | Never played, barely played, or idle more than 365 days | Never: 4; barely: 3; long idle: 2; highest applicable weight | never_launched, barely_played, idle |
| Something Different | Outside the 30-day recent rotation, with no positive two-week activity | Never: 2; other eligible games: 1 | outside_rotation, never_launched, idle |
| Comfort Pick | At least 1,200 lifetime minutes | Square root of minutes / minimum, capped at 4 | comfort |
| Rediscovery | At least 600 lifetime minutes and idle more than 180 days | Idle days / idle threshold, capped at 4 | rediscovery |

All modes support the shared scope kinds; the catalog offers only scopes with registered resolvers. The existing sampler applies `weight ^ samplerGamma` (default 1.5). Weights bias selection without making any eligible game certain. Reasons use the existing structured reason model and single renderer; Rediscovery includes both lifetime hours and idle months. Months use 30 days.

## Pure backlog interface

`src/lib/library/backlog.ts` exports each predicate and `BACKLOG_CATEGORIES`, keyed by the six category IDs. Pass a `Candidate` and `{ now, thresholds, playtimeHidden? }`; `now` is Unix seconds. Results are `match`, `no-match`, `unknown` (hidden playtime or unknown recency), or `unscanned` (missing, null, empty, or invalid achievement summary). Only `match` means membership. Categories can overlap.

| Predicate | Default definition |
| --- | --- |
| neverPlayed | Lifetime minutes <= 0 |
| barelyPlayed | Lifetime minutes > 0 and < 120 |
| notPlayedInLongTime | Played before and idle > 90 days |
| startedButAbandoned | 30 through 600 minutes inclusive, idle >= 90 days |
| lowCompletion | Indexed achievement percent < 60, with locked achievements |
| highCompletionButUnfinished | Indexed achievement percent >= 80 and < 100, with locked achievements |

All boundaries read `ctx.thresholds`, whose defaults live in `roulette/thresholds.ts` (D5). Low completion uses the existing `finishSomethingPreferPercent` boundary; high completion uses `closeToCompletePercent`. The middle completion band is deliberately outside both categories. No achievement fetching occurs: the library scope already attaches `ap`/`au`/`at` summaries to candidates when available. Missing summaries never match. An empty/no-stats summary reports `unscanned` for these predicates and is not a completion candidate.

## Unknown signals

The scope's `playtimeHidden` flag now reaches both spin scoring and pool-preview scoring via an optional internal score context field. All four modes yield no eligible candidates for hidden totals, and the four playtime category predicates return `unknown`. Achievement categories remain usable with hidden totals.

Never-launched games can match Dust Collector and Something Different without a last-played timestamp. A played game with unknown last-played time cannot establish long idle or outside rotation. Positive two-week activity overrides a stale timestamp. Comfort Pick needs no recency information. No fallback turns hidden totals into zero or old Steam timestamp sentinel 0 into known idle.

## Validation and package boundary

`tests/qit-modes-playtime.test.ts` covers scoring weights, reasons through the renderer, registry/core sampling, all category boundaries, tunable thresholds, missing achievement summaries, unknown recency, and hidden totals. Spin tests cover hidden totals in both actual spins and previews; registry and catalog tests reflect the implemented modes.

No Backlog Discovery page, Daily selection, or picker UI is added here. D7's Dust Collector / Rediscovery / Finish Something / Something Different mix remains for the Daily package. Group scopes must supply accurate requester playtime and propagate hidden-playtime state when they land; the current library scope already does so.
