# App metadata

`src/lib/apps/metadata.ts` caches Steam store metadata per app and exposes the store flags that filters and modes read. It is additive: `genre-cache.ts` and `apps/{appid}` (overwritten with plain `set`) are untouched.

## Cache: `appMeta/{appid}`

Filled by `getStoreItems` (batched `IStoreBrowseService/GetItems`, keyless, 100 appids per call) through the shared Steam client, so retry, limiter and timeouts come from `src/lib/steam/`. Record type: `AppMetaRecord` in `src/lib/store/types.ts`.

| Field | Meaning |
|---|---|
| `state` | `ok`, or `unknown`: the negative entry for apps Steam has nothing on (`success: 15`, delisted or hidden) |
| `type` | `game`, `demo`, `tool`, `dlc`, `software`, `music`, or `type<N>` for a numeric type not yet seen |
| `categories` | every store category id (player, feature and controller) |
| `flags` | the store flag bits below (0 for `unknown`) |
| `tagids`, `release` (Unix s), `art`, `review` (1-9), `reviewPercent`, `reviewCount`, `parentAppid` | as returned; absent means unknown |
| `fetchedAt` | Firestore `Timestamp` |

Freshness is `fetchedAt` plus 7 days (`ok`) or 30 days (`unknown`); readers check it themselves and no TTL policy is required. `art` keeps the file names for `header`, `main_capsule`, `small_capsule`, `library_capsule`, `library_hero` and `community_icon`; `appArtUrl(appid, art, 'header')` builds the CDN URL (`shared.steamstatic.com/store_item_assets/steam/apps/{appid}/{file}`, verified 200 for hashed and plain names).

`getAppMeta(appids, { maxFetch, force })` reads the cache (one read per app), fetches missing or expired apps in batches of 100, writes the answers, and returns `{ meta, unresolved, fetched }`. A failed Steam batch caches nothing (a transient error is never remembered as "unknown"): the app comes back from an expired copy with `stale: true` if one exists, otherwise in `unresolved`. `maxFetch` bounds the apps sent to Steam per call for the spin's enrichment budget.

## Flag bits (`f` in the library index)

| Bit | Value | Meaning |
|---|---|---|
| `known` | 1 | Steam gave category data; without it every flag is unknown |
| `singlePlayer` | 2 | category 2 |
| `multiplayer` | 4 | category 1, or any co-op, PvP or MMO category |
| `coop` | 8 | categories 9, 38, 39, 48 |
| `pvp` | 16 | categories 36, 37, 47, 49 |
| `mmo` | 32 | category 20 |
| `achievements` | 64 | category 22 (Steam Achievements) |
| `nonGame` | 128 | type known and not `game` (feature 17 hides these by default) |

`f` missing means "not checked yet"; `f: 0` means "checked, nothing known" (negative cache entry); the `known` bit distinguishes a real `false` from unknown. Category ids were confirmed against live answers (Portal 2, Destiny 2, Stardew Valley, Dota 2, Counter-Strike 2). Steam's data decides: Counter-Strike 2 currently declares no PvP category, so its `pvp` flag is `false`.

For feature 18 (filters): `FILTERABLE_FLAGS` lists `{ id, label, bit }` for the six `StoreFlag`s of `src/lib/roulette/types.ts`; `storeFlag(f, id)` returns `true`, `false` or `null` (unknown), `decodeStoreFlags(f)` returns the whole `Record<StoreFlag, boolean | null>`, `matchesFlags(f, ['coop', 'achievements'])` is true only when every flag is known and set, `isNonGame(f)`, and `storeSignalsOf(meta)` builds the roulette's `StoreSignals` (unknown apps: `type: null`, all flags `null`, no art). Callers decide what unknown means for their filter; nothing here treats it as false.

## Filling the library index

`enrichLibraryFlags(steamId, { appids, maxFetch, force })` reads the index (four reads), finds entries whose `f` is missing or unknown (only among `appids`, in that order, when given, which bounds the `appMeta` reads), loads their metadata with `getAppMeta`, and patches `f` through `patchLibIndex` in its default existing-only mode, so it can never resurrect a game the library sync removed and never touches another writer's fields. It returns `{ requested, fetched, patched, unresolved, coverage }`; repeat while `unresolved > 0`. Apps Steam does not know get `f: 0`; an unknown answer never overwrites flags that are already known, and an entry whose `f` is unchanged is not rewritten.

The package adds no route: callers (the spin pipeline's enrichment, or a scan route) invoke these functions.

## Tests

`tests/qit-app-metadata.test.ts` (unit: flag mapping, records, cache, batching, failure handling, index patching) and `tests/qit-app-metadata.emulator.test.ts` (Firestore emulator: cache round-trip, negative entries, index patching, no resurrection of removed games).
