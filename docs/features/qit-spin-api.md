# Spin API: the server roulette pipeline

The server now picks the game. `POST /api/roulette/spin` runs the pipeline from plan section 2.5 over the signed-in user's library, returns a result `Card` and records the roll in the event store. `POST /api/roulette/pool` returns the live counts for the picker, and `GET /api/roulette/modes` lists what the picker may offer. The pipeline connects packages that are already merged: the library index (library-model, store-layer), store flags (app-metadata), the exclusion stage and filters (filter-engine), scoring and the seeded sampler (roulette-core), and rolls and exclusions (event-store). It does not re-implement any of them.

| File | Holds |
|---|---|
| `src/lib/roulette/request.ts` | `parseSpinRequest`, `parseScope`: validation of request bodies (pure) |
| `src/lib/roulette/pipeline.ts` | `runSpin`, `runPoolPreview`, `coverageOf`, `SpinInputError`, and the `PipelineDeps`, `SignalLoader` and `ScopeResolvers` contracts. It imports no Firestore or Steam code |
| `src/lib/roulette/card.ts` | `buildCard`: from the drawn game to the `Card` DTO (pure) |
| `src/lib/roulette/scopes/library.ts` | the `library` scope resolver, and candidates built from index entries or legacy per-game documents |
| `src/lib/roulette/scopes/index.ts` | `SCOPE_RESOLVERS`, the scope registry |
| `src/lib/roulette/enrich.ts` | `SIGNAL_LOADERS`: history, and bounded store enrichment |
| `src/lib/roulette/service.ts` | the pipeline wired to Firestore and Steam (`spin`, `previewPool`, `modesCatalog`) |
| `src/app/api/roulette/{spin,pool,modes}/route.ts` | the routes |

## Pipeline

1. **Resolve the scope.** The resolver registered for `scope.kind` returns the candidates, the members and any unavailable players. The library resolver reads the user document and the four library index chunks. Each index entry becomes a candidate with `library` signals. It also gets `store` signals from the flag bits `f`, and `achievements` from `ap`/`au`/`at`, when the entry has them. A family the entry has no data for is left out, which means "not loaded" rather than zero. Users whose index is not built yet are read from their per-game documents, with library signals only, until their next sync.
2. **Load what the exclusion stage and filters read** (`requiredFamilies`), for the whole scope.
3. **Exclusions, then filters** (`applyPool`). Games vetoed by an active exclusion, the request's `exclude` list, and non-games (D17, unless `showNonGames`) leave the pool. Then each filter applies in request order. A game a filter cannot judge stays out (the engine's default `unknown: 'exclude'`), and the preview counts it.
4. **Load signals only the mode needs** for the games that survived the filters.
5. **Score and draw** with the mode (`roll`) and a seeded rng. The seed is the request's `seed` or a fresh `randomSeed()`, and it is returned so the draw can be replayed over the same pool.
6. **Record the roll** with `recordRoll`. It stores the mode, the validated filters, the scope, the participants, `playtimeAtRoll` (null when Steam hides playtime) and up to 10 reasons, and writes the `roll` event and counters in the same transaction.
7. **Build the `Card`.** It has the top three reasons, header art (the store signals' art, otherwise the `appMeta` header, otherwise null so the card falls back to the icon), the icon, playtime, last played, the achievement summary, live signals, previous selections (rolls inside the history window before this one), and the store and `steam://run` links. `friends` is null for the library scope.

An empty pool, or a mode that finds nothing eligible, returns `card: null` and records nothing. A roll that cannot be stored, or a header art lookup that fails, is logged, and the card still comes back (`rollId: null` or `header: null`).

### Signal loaders and bounded enrichment

| Family | Source |
|---|---|
| `library` | the scope resolver |
| `store` | the index flag bits. For games with no bits yet, a spin runs app-metadata's `enrichLibraryFlags` with `maxFetch` 1000 (at most 10 keyless GetItems calls), which patches `f` into the index, and then reads the bits back. Scopes outside the library use the `appMeta` cache (`getAppMeta`, at most 1000 reads). A failure never fails the spin: those games stay unknown |
| `history` | `readExclusions` (one read, with the request's `sessionId` so "Hide for this session" applies) and `recentlyRolled` (one range query of at most 500 rolls). The window is 30 days (D6), or longer when the `exclude-rolled` filter asks for more. `playedAfterRoll` is always false until qit-played-detection lands |
| `achievements` | the index summary only. There is no Steam scan here: achievements-data owns scanning (D13) |
| `live`, `group` | no loader yet. qit-player-counts and the group scopes add theirs to `SIGNAL_LOADERS` |

Pool previews (`fetch: false`) never call Steam: store flags come from the index only.

`coverage` gives, for each family the stages or the mode read, the share of candidates that had it loaded (0 to 1, four decimals, 1 for an empty list). Stage families are measured over the whole scope. Mode-only families are measured over the filtered pool. An unloaded family is never read as zero. For example, `coverage.store` below 1 means some games could not be checked yet.

### Playtime hidden

When Steam hides the requester's playtime (`flags.playtimeHidden`, set by the library sync), every game reads 0 minutes. So the pipeline refuses `never-played`, `playtime`, `recently-played` and `not-recently-played` with a 400, stores `playtimeAtRoll: null`, and returns `playtimeHidden: true` so the picker can explain why.

## API

Every route needs a session and answers with `Cache-Control: private, no-store` and the route-guards error envelope. POSTs need a same-origin request and accept bodies of at most 16 KiB. Rate limits are per user and per IP: spin allows 10 in a burst, then 1 every 5 s. Pool and modes allow 30 in a burst, then 1 per second.

### `POST /api/roulette/spin`

```json
{ "mode": "pure-random", "filters": [{ "id": "never-played" }], "scope": { "kind": "library" },
  "exclude": [620], "showNonGames": false, "sessionId": "picker-1", "seed": "optional" }
```

Only `mode` is required. The scope defaults to the library. Unknown fields, stub modes, stub or invalid filters, a mode that does not support the scope, more than 500 `exclude` appids, and malformed scopes are rejected with 400. A scope kind with no resolver yet (`friends`, `pair`, `lobby`, `appids`) also gets a 400 ("not available yet").

Response: `{ card, poolSize, coverage, seed, eligible, preview, playtimeHidden }`. `preview` is the filter engine's `PoolPreview`: the total, removals by cause, one step per filter, and the final count.

### `POST /api/roulette/pool`

This takes the same body without `seed`, and `mode` is optional. The response is `{ preview, coverage, eligible, playtimeHidden }`. `eligible` is the number of games the mode would find eligible, or null when no mode is named. Nothing is written.

### `GET /api/roulette/modes`

This returns `{ modes, filters, scopes }`: the implemented modes (with the scopes they can use today), the implemented filters with the families they require, and the scope kinds that have a resolver. Stubs are never listed. Today that is Pure Random, all eleven filters, and the `library` scope.

## Extending

- **Modes.** A mode package replaces its stub file under `modes/`. The spin API picks the mode up through the registry with no change here, and `/modes` lists it once `stub` is false.
- **Scopes.** Add a `ScopeResolver` under `scopes/` and one line in `SCOPE_RESOLVERS`. The resolver can return `playtimeHidden` (`SpinScopeResult`). Put the readable players in `members` (requester first) and the unreadable ones in `unavailable`. The pipeline passes both to the filters.
- **Signals.** Add a `SignalLoader` for the family in `SIGNAL_LOADERS`. A loader fills the candidates in place, leaves the ones it cannot resolve unloaded, and should throw only when the request must fail.

Known limits: `previousSelections` and the anti-repeat filter see at most the 500 newest rolls in the window. The non-game bit written by app-metadata also covers demos, so indexed demos are hidden with the other non-games.

## Tests

- `tests/qit-spin-api.test.ts` (`npm test`) covers request and scope validation, candidates built from index entries, the pipeline with plain-data dependencies, the loaders, and the routes. The pipeline tests include exclusions, non-games, filters with unknown data, seed replay, empty pools, roll-recording failures, the order in which families are loaded, coverage, playtime hidden, and unavailable scopes. The route tests include auth, same-origin, validation, the body cap, error hiding, rate limits and the modes catalog.
- `tests/qit-spin-api.emulator.test.ts` (`npm run test:firestore`) runs end to end against the emulator. It covers Pure Random over the index with forever and session vetoes, a non-game and the request's exclusions; the stored roll, event and counters; the anti-repeat window; store flags filled during a spin but not during a preview; a pool preview costing 7 reads whatever the library size; and a user whose index is not built yet.
