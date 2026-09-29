# Store layer

`src/lib/store/` is the Firestore data-access foundation for the new features. It is additive: existing modules (`library-data.ts`, `genre-cache.ts`, `achievement-cache.ts`) are unchanged and keep their own paths until their owning packages move them over.

| File | Holds |
|---|---|
| `paths.ts` | `COLLECTIONS` and `paths.*`, the only place that spells collection names. Every id is validated (Steam ID, appid, chunk, `yyyy-mm-dd`, generated ids `[A-Za-z0-9_-]{1,128}`), so a caller cannot inject `/` or `..`. Use `db.doc(paths.roll(steamId, rollId))` and `db.collection(paths.rolls(steamId))`. |
| `types.ts` | Record types for every collection in plan section 2.3. New time fields are Firestore `Timestamp`s. A missing optional field means unknown, never zero. |
| `converters.ts` | `recordConverter<T>()` (typed, strips `undefined`), `libIndexChunkConverter` (drops malformed entries and fields on read), `toTimestamp`, `expiresIn`, `isExpired` (readers check `expiresAt` themselves; TTL deletion is only housekeeping). |
| `tx.ts` | `runTransaction`, `commitInBatches` (450 writes per batch), `getAllInGroups` (100 refs per `getAll`). |
| `limits.ts` | Firestore's 1 MiB document and 40,000 index-entry limits, `documentSize` (the documented storage size rules), `estimateIndexEntries`. |
| `lib-index.ts` | The library index helpers below. |

## Library index

`users/{steamId}/libIndex/{libIndexChunkOf(appid)}` with one field, `games`, a map keyed by appid, plus `updatedAt` (server timestamp). Entry fields, each with one writer:

| Field | Meaning | Writer |
|---|---|---|
| `n`, `i`, `p`, `w`, `r`, `s` | name, icon hash, playtime_forever, playtime_2weeks (minutes), rtime_last_played (Unix seconds), has_community_visible_stats (1 or 0) | library-model |
| `f` | store flag bits | app-metadata |
| `ap`, `au`, `at` | achievement percent, unlocked, total | achievements-data |

- `readLibIndex(steamId)` does one `getAll` of the four chunks: four reads per library load, whatever the library size. It returns `{ entries: Map<appid, entry>, built, updatedAt }`; `built` is false when no chunk exists (never synced), unlike an empty library.
- `patchLibIndex(steamId, patches)` writes only the fields given, as merge writes, so writers of different field groups never clobber each other. `null` removes a field (back to unknown); `undefined` is ignored; unknown fields and non-finite numbers throw.
  - Default mode touches only entries already in the index. It runs in a transaction that reads the touched chunks, so a late metadata or achievement write cannot resurrect a game the sync removed. It returns `{ applied, skipped }`.
  - `{ create: true }` is for the library sync, which owns entry existence: a blind upsert with no reads, and every entry must carry `n`.
- `removeFromLibIndex(steamId, appids)` deletes whole entries in a transaction and never creates a missing chunk.

Readers skip entries without a name, so a partial entry can never surface as a game.

### Index exemption

`firestore.indexes.json` exempts `games` on the `libIndex` collection group from single-field indexing (`"indexes": []`). Firebase documents that a map field's subfields inherit its exemption ("If you create an index exemption for a map field, the map's subfields inherit those settings", Index types page). Without it, each entry field gets ascending and descending entries: each game costs about 20 index entries, so a chunk would reach the 40,000 per-document limit at about 2,000 games (roughly an 8,000-game library) and larger writes would fail. **Deploy it before library-model writes the first chunk**: `firebase deploy --only firestore:indexes`. There are no composite indexes, by design, because the emulator cannot catch a missing one. The emulator does not enforce the index-entry limit or apply `fieldOverrides`, so no emulator test verifies the exemption; confirm it after deploy by checking the deployed index configuration (`firebase firestore:indexes`, or the console's single-field exemptions list shows `games` on `libIndex`).

### Chunking

`libIndexChunkOf(appid)` is the single owner of the chunk rule, and every reader and writer goes through it. Other packages must call it and never compute a chunk themselves. It is a multiplicative (Fibonacci) hash of the appid keeping the top two bits. Plain `appid % 4` would not do: about 95% of Steam appids are multiples of 10, which land only in chunks 0 and 2. The hash spreads any stride of appids (1, 10, 20, 40, 100) within one percentage point of 25% per chunk. Changing the function moves every entry, so it is fixed once library-model writes real data.

### Size check (synthetic 8,000-game library, every field populated)

| Chunk | Games | Size | Index entries with exemption / without |
|---|---|---|---|
| 0 | 1,973 | 324,018 B (30.9% of 1 MiB) | 2 / 39,464 |
| 1 | 1,990 | 326,007 B (31.1%) | 2 / 39,804 |
| 2 | 2,010 | 329,934 B (31.5%) | 2 / 40,204 |
| 3 | 2,027 | 333,800 B (31.8%) | 2 / 40,544 |

The test models real Steam appids, about 95% of which are multiples of 10, with names of 8 to 64 characters, at about 164 bytes per game. Each chunk could hold about 6,370 games before reaching 1 MiB, so the ceiling is roughly 25,000 games, and 8,000 games use under a third of each chunk. The index-entry columns come from the repo's own estimator (`estimateIndexEntries`), not from Firestore: they model the documented behaviour and show that without the exemption the index-entry limit, at about 2,000 games per chunk, would cap the library well before the size limit. They do not verify that the exemption is deployed.

## Tests

- `tests/qit-store-layer.test.ts` (`npm test`): path validation, patch planning, converters, the size rules against Firebase's worked example, and the exemption in `firestore.indexes.json`.
- `tests/qit-store-layer.firestore.test.ts` (`npm run test:firestore`, needs Java for the emulator; skipped when `FIRESTORE_EMULATOR_HOST` is unset): the 8,000-game library within the document size limit and the estimated index-entry limit (a stand-in: the emulator enforces neither the index-entry limit nor `fieldOverrides`) and loaded in at most four reads (counted by spying on every read path), three writers patching the same 200 entries concurrently without losing fields, removal without resurrection, and the never-built state.
