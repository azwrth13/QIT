# Roulette core: scoring, seeded sampler, reasons and Pure Random

The pure center of the roulette (features 1 and 8). It covers how a mode scores games, how one is drawn, and how the "why this game" reasons become text. Nothing here reads Firestore or calls `fetch`. The spin pipeline (`qit-spin-api`) builds the pool, applies exclusions and filters, calls these functions and turns the pick into a `Card`.

| File | Holds |
|---|---|
| `src/lib/roulette/scoring.ts` | `scoreCandidates`, `drawScored`, `roll`, `ModeScopeError` |
| `src/lib/roulette/sampler.ts` | `createRng`, `randomSeed`, `composeSeed`, `weightedSample` |
| `src/lib/roulette/reasons.ts` | `reason`, `renderReason`, `renderReasons`, `orderReasons`, `parseReason`, `REASON_CODES`, `CARD_REASON_LIMIT` |
| `src/lib/roulette/modes/pure-random.ts` | the Pure Random mode (no longer a stub) |

## Scoring

A mode is a pure function `score(candidate, ctx) => { eligible, weight, reasons }` (the `Mode` contract in `types.ts`).

- `scoreCandidates(mode, candidates, ctx)` runs the mode over the pool. It returns the eligible candidates as `{ candidate, weight, reasons }`, with reasons sorted by the mode's `emits` priority.
  - An ineligible candidate drops out, and so does one with weight 0.
  - A negative, `NaN` or infinite weight throws `RangeError`, because it is a bug in the mode.
  - A stub mode throws `StubNotImplementedError`. If `ctx.scope.kind` is not in `mode.scopes`, it throws `ModeScopeError`. For example, Everyone Owns It cannot score a plain library scope.
- `drawScored(scored, { rng, gamma, count })` draws `count` distinct games (default 1). It sorts the pool by appid first, so a seed gives the same pick however the pool was assembled. A pool that holds the same appid twice throws.
- `roll(mode, candidates, ctx, { rng, count })` scores and then draws with `ctx.thresholds.samplerGamma`. It returns `{ picks, eligible }`.

## Sampler

- `weightedSample(entries, count, { rng, gamma })` draws without replacement. Each draw picks among the remaining items with probability proportional to `weight ^ gamma`. The plan's default gamma is 1.5 (`THRESHOLDS.samplerGamma`), so modes bias the pick rather than dictate it. Gamma 0 makes every item equally likely.
  - It uses Efraimidis-Spirakis exponential keys, compared in log space so extreme weights cannot overflow.
  - Each item consumes exactly one rng draw, in input order. So the same entries with the same seed give the same result, and a smaller `count` returns a prefix of a larger one. A lobby or Daily can therefore store one seed and read "the next pick" as the next position.
  - Weights must be finite and above 0. Leave ineligible items out instead of giving them weight 0.
- `createRng(seed)` is sfc32, seeded through the cyrb128 string hash. It returns draws in `[0, 1)`.
- `randomSeed()` returns 128 random bits as hex, from `crypto.getRandomValues`. Use it for spins that are not deterministic, and store it with the result so the draw can be replayed.
- `composeSeed(...parts)` joins seed parts without ambiguity (a JSON array). For example, the Daily seed is `composeSeed('daily', steamId, localDate, modeId, rerollIndex)`.

**Stored seeds depend on these algorithms.** Changing the hash, the generator, the key formula or the appid ordering changes the result of every stored Daily and lobby seed. Golden vectors in `tests/qit-roulette-core.test.ts` pin the current behavior, so such a change fails a test on purpose.

## Reasons

Reasons are `{ code, params }` values (`ReasonParams` in `types.ts`). `reasons.ts` is the only place that turns them into text.

- `reason(code, params)` is a typed constructor.
- `orderReasons(reasons, priority)` orders reasons by a mode's `emits` list. Codes the mode does not declare, such as group reasons the pipeline adds, follow in their original order. Only the first reason of each code is kept. `scoreCandidates` applies it.
- `renderReason(reason)` returns one English sentence. `renderReasons(reasons, limit = 3)` returns the texts a card shows (`CARD_REASON_LIMIT`).
- `parseReason(value)` validates a reason read back from Firestore or the wire. It returns a clean copy without unknown params, or `null` when the code is unknown or a number is missing, negative, not finite, or fractional where a count is expected. Always parse stored reasons before rendering them.

| Code | Example |
|---|---|
| `random_pick` | Picked completely at random |
| `never_launched` | You've never launched it |
| `barely_played {minutes}` | You've only played it for 1 hour 35 minutes |
| `idle {months}` | You haven't played it in 14 months / over 3 years |
| `outside_rotation` | It's outside your recent rotation |
| `comfort {hours}` | An old favorite: you've put 212 hours into it |
| `rediscovery {hours, months}` | You played this for 64 hours but haven't touched it in 7 months |
| `ach_remaining {remaining, total}` | 28 of 40 achievements still to unlock |
| `ach_near_complete {percent, remaining}` | You're already 91% through the achievements in this game (3 to go) |
| `rare_remaining {count, threshold}` | 3 locked achievements are held by under 10% of players |
| `active_now {players, band}` | Busy right now: 12,345 players online (`low` gives "Quiet right now", otherwise "... online right now") |
| `friends_all_own {count}` | All 4 players own it / Both players own it |
| `friends_never_played {count}` | 2 players have never played it |
| `not_rolled_recently` | QIT hasn't suggested it lately |

Percentages are floored, so 99.6% never reads as finished. Other numbers are rounded and formatted in `en-US`. Adding a reason code takes one entry in `ReasonParams` (types), one in `PARAM_SPECS` and one `case` in `renderReason`. The `switch` is exhaustive, so a missing case fails the type check.

## Pure Random

`modes/pure-random.ts` is the first mode that is not a stub. It needs only the library signals, works in every scope, gives every candidate weight 1 (so gamma has no effect) and emits `random_pick`. `tests/qit-foundation.test.ts` lists the implemented modes; see `docs/features/qit-modes-playtime.md` for the playtime modes.

## Tests

`tests/qit-roulette-core.test.ts` checks the following. The distribution checks use fixed seeds and chi-square bounds at the 0.1% tail, so they are deterministic, not flaky.

- Golden vectors for the rng and a seeded draw, and the prefix property.
- Draws without replacement.
- First-pick frequencies proportional to `weight ^ gamma` (gamma 1, 1.5 and 0), and second-pick frequencies from the remaining weights.
- Pool-order independence, scoring rules, and Pure Random uniformity.
- Every reason's text, and `parseReason` on malformed input.
