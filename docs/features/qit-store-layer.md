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

`users/{steamId}/libIndex/{appid % 4}` with one field, `games`, a map keyed by appid, plus `updatedAt` (server timestamp). Entry fields, each with one writer:

| Field | Meaning | Writer |
|---|---|---|
| `n`, `i`, `p`, `w`, `r` | name, icon hash, playtime_forever, playtime_2weeks (minutes), rtime_last_played (Unix seconds) | library-model |
| `f` | store flag bits | app-metadata |
| `ap`, `au`, `at` | achievement percent, unlocked, total | achievements-data |

- `readLibIndex(steamId)` does one `getAll` of the four chunks: four reads per library load, whatever the library size. It returns `{ entries: Map<appid, entry>, built, updatedAt }`; `built` is false when no chunk exists (never synced), unlike an empty library.
- `patchLibIndex(steamId, patches)` writes only the fields given, as merge writes, so writers of different field groups never clobber each other. `null` removes a field (back to unknown); `undefined` is ignored; unknown fields and non-finite numbers throw.
  - Default mode touches only entries already in the index. It runs in a transaction that reads the touched chunks, so a late metadata or achievement write cannot resurrect a game the sync removed. It returns `{ applied, skipped }`.
  - `{ create: true }` is for the library sync, which owns entry existence: a blind upsert with no reads, and every entry must carry `n`.
- `removeFromLibIndex(steamId, appids)` deletes whole entries in a transaction and never creates a missing chunk.

Readers skip entries without a name, so a partial entry can never surface as a game.

### Index exemption

`firestore.indexes.json` exempts `games` on the `libIndex` collection group from single-field indexing (`"indexes": []`). Firebase documents that a map field's subfields inherit its exemption ("If you create an index exemption for a map field, the map's subfields inherit those settings", Index types page). Without it, each entry field gets ascending and descending entries: the 8,000-game test library would need about 80,000 entries in one chunk, twice the 40,000 per-document limit, so large writes would fail. **Deploy it before library-model writes the first chunk**: `firebase deploy --only firestore:indexes`. There are no composite indexes, by design, because the emulator cannot catch a missing one.

### Size check (synthetic 8,000-game library, every field populated)

| Chunk | Games | Size | Index entries with exemption / without |
|---|---|---|---|
| 0 | 3,828 | 627,981 B (59.9% of 1 MiB) | 2 / 76,564 |
| 1 | 103 | 17,026 B (1.6%) | 2 / 2,064 |
| 2 | 3,988 | 655,234 B (62.5%) | 2 / 79,764 |
| 3 | 81 | 13,518 B (1.3%) | 2 / 1,624 |

The test models real Steam appids, about 95% of which are multiples of 10, with names of 8 to 64 characters. Because of that, `appid % 4` is uneven: multiples of 10 land only in chunks 0 and 2. Two chunks carry almost the whole library, at about 164 bytes per game, so the ceiling is roughly 12,000 to 13,000 games before a chunk reaches 1 MiB, not the 25,000 an even split would allow. 8,000 games fit with about 37% headroom per chunk. If more headroom is needed, `(appid / 10) % 4` or a hash spreads the entries evenly. The chunk function is `libIndexChunkOf`, and changing it costs nothing only until library-model has written real data.

## Tests

- `tests/qit-store-layer.test.ts` (`npm test`): path validation, patch planning, converters, the size rules against Firebase's worked example, and the exemption in `firestore.indexes.json`.
- `tests/qit-store-layer.firestore.test.ts` (`npm run test:firestore`, needs Java for the emulator; skipped when `FIRESTORE_EMULATOR_HOST` is unset): the 8,000-game library within the document and index-entry limits and loaded in at most four reads (counted by spying on every read path), three writers patching the same 200 entries concurrently without losing fields, removal without resurrection, and the never-built state.
