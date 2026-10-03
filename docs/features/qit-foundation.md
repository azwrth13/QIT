# Foundation: roulette contracts, registries, nav flags and test plumbing

Shared contracts that later packages build against. Nothing here changes behavior yet: every mode and filter starts as a stub (see `docs/features/qit-roulette-core.md` for Pure Random, the first real mode, and `docs/features/qit-filter-engine.md` for the filters, which are all implemented), and the navbar shows only the surfaces whose packages have flipped their own flag.

## Roulette contracts (`src/lib/roulette/`)

- `types.ts` holds the contracts: `Candidate`, `Signals`, `Mode`, `Filter`, `Reason`, `Card`, `Scope`, `ScopeResolver`, `SpinRequest` and `SpinResponse`, plus the id lists `MODE_IDS`, `FILTER_IDS` and `SCOPE_KINDS`. The roulette engines are pure: they never import Firestore or `fetch`.
- Unknown is not zero. If a signal family is missing from `Signals`, it has not been loaded. A `null` field means the value is unknown, for example an app with no player counter or a game whose achievements are not scanned yet. Filters return `'pass' | 'fail' | 'unknown'` so the pipeline decides the policy and reports `coverage`.
- Reasons are structured as `{ code, params }`, typed by `ReasonParams`. Only `reasons.ts` turns them into text; `docs/features/qit-roulette-core.md` covers the codes and how to add one.
- `thresholds.ts` exports `THRESHOLDS` (frozen). These are the section 2.4 defaults plus D4 (a played delta of 10 minutes), D6 (anti-repeat options off, 7, 30 and 90 days) and D15 (a floor of 100 players). Engines receive thresholds through `ScoreContext` or `FilterContext` rather than importing the constant, so tests can change them.

## Mode and filter registries

Each mode and filter id has one file: `modes/<id>.ts` and `filters/<id>.ts`. The `index.ts` in each folder maps every id to its file. If the map misses an id, compilation fails. Lookups are `getMode`, `getFilter`, `listModes`, `listFilters`, and the guards `isModeId` and `isFilterId` for request input.

| Kind | Ids |
|---|---|
| Modes (9) | `pure-random`, `dust-collector`, `something-different`, `comfort-pick`, `achievement-hunter`, `alive-and-kicking`, `everyone-owns-it`, `finish-something`, `rediscovery` |
| Filters (11) | `multiplayer`, `co-op`, `single-player`, `achievements`, `never-played`, `playtime` (min and max), `recently-played`, `not-recently-played`, `player-activity`, `shared-with-friends`, `exclude-rolled` |

There is no `installed` filter, because Steam exposes no installed state and the captain decided to drop the filter (D14). Hiding non-game apps (D17) and the veto exclusions (feature 14) are pipeline stages, not filter ids.

Each file starts as a `stubMode` or `stubFilter` with `stub: true`. A stub's `score` and `test` throw `StubNotImplementedError`, and a stub filter's `parse` returns `null`, so a request that names a stub fails validation. To implement one, the owning package replaces the body of its own file with a real `Mode` or `Filter` that has `stub: false`. The index and other packages' files stay untouched. The spin API and the UI must offer only entries where `stub` is false.

## Navigation flags (`src/app/navbar/nav-items.ts`)

`NAV_ITEMS` lists every surface with an `href`, an `enabled` flag, `requiresAuth` and `inNavbar`. The navbar renders `navbarItems(signedIn)`. When a surface ships, its package flips its own `enabled` line. Links or buttons that point at another surface, such as "Compare" on a friend card, should check `isNavEnabled(id)` so they stay hidden until that surface exists. `compare` and `privacy` are reached from other pages, so they are not in the navbar.

## Friend selection URL contract (`src/lib/links/with-param.ts`)

Pages hand a friend selection to another page as `?with=<steamid>,<steamid>`, for example `/friend-night?with=76561198000000001,76561198000000002`.

- Build links with `withHref(path, ids)`. It keeps other query params and the hash, and it drops the param when the selection is empty.
- Read with `parseWithParam(value)`. It accepts a string, repeated params (Next `searchParams`) or `null`. It drops invalid ids and duplicates, keeps order, and caps the list at `MAX_WITH_IDS` (16) so a crafted link cannot fan out into unbounded Steam lookups. The consuming page may apply a lower product limit.

## Tests

`npm test` runs `vitest run --project unit`. That project picks up every `tests/**/*.test.*` file, so a new test file needs no `package.json` edit. Tests that need the Firestore emulator (`tests/firestore.test.ts`, `tests/qit-store-layer.firestore.test.ts`, and any `tests/**/*.emulator.test.*`) live in the `firestore` project, which `npm run test:firestore` runs inside `firebase emulators:exec`. `tests/library.test.mjs` is now the vitest file `tests/library.test.ts`. The Node type-stripping limit on imports in `steam.ts` and `games.ts` is gone: both files can now import other project modules.
