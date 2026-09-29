# Friends data

`src/lib/social/` holds the friend data that Friend Night, the lobby, library comparison and the friend dashboard build on. It calls Steam only through the shared client in `src/lib/steam/` and touches Firestore only through `src/lib/store/` paths.

| Module | Holds |
|---|---|
| `friends.ts` | `getFriends(steamId)`: the 15-minute friends snapshot with status and current game. The only writer of `users/{id}/meta/friends`. |
| `pinned.ts` | `pinPlayer`, `unpinPlayer`: pinned players for a private friends list (D11). The only writer of `users/{id}/meta/pinned`. |
| `libraries.ts` | `getLibraryFor(ids)`: other players' libraries with a state per player. The only writer of `publicLibraries/{steamId}`. |
| `store.ts` | `SocialStore` and its Firestore implementation, `firestoreSocialStore`. |
| `deps.ts` | `SocialDeps` (`store`, `client`, `now`), the seams unit tests use to inject fakes. Production code passes nothing. |

## Friends snapshot

`getFriends` returns `{ friends, message?, source }`. `friends` and `message` are the fields the home page reads (`src/app/page.tsx`); each friend is `{ steamId, personaName, profileUrl, avatarFull, avatarMedium }` plus, when Steam shares them, `status` (Steam's `personastate`, an index into `PERSONA_STATES`) and `currentGame: { appid, name }` (`appid` is null for a non-Steam game). `source` is `friends`, or `pinned` when the friends list is private and the players are the pinned ones.

- **Snapshot.** `users/{id}/meta/friends` holds `{ ids, summaries, state, fetchedAt }`. It is reused for 15 minutes (`FRIENDS_TTL_MS`), then refreshed with one `GetFriendList` call and `ceil(F/100)` `GetPlayerSummaries` calls. Status and current game are therefore up to 15 minutes old. A snapshot dated in the future counts as expired.
- **Failure.** If a refresh fails, the stale snapshot is served (an old list beats an error); with no snapshot at all, the call throws and the route answers 502. A Firestore read that fails counts as a miss and a write that fails is logged and ignored, so a Firestore problem never takes the friends list down. Concurrent calls for one user share one refresh on an instance.
- **Messages.** The private-list message keeps its wording from before; an empty list keeps "No Steam friends to suggest yet."; a private list with pins says so (`PINNED_MESSAGE`). The old code told "private" and "private or unavailable" apart; `getFriendList` reports both as private, so there is one message now.
- **Size.** A snapshot that would pass Firestore's 1 MiB document size or 40,000 index entries (about 2,200 friends) is not written and is refetched on every request instead. Nothing fails.
- **Deleted accounts** have no summary and are left out, as before.

### Pinned players (D11)

When `GetFriendList` says the list is private (a JSON 401, as recorded in `qit-steam-client.md`), the pinned players stand in for the friends. `ids` in a private snapshot are the pinned ids already looked up, so:

- a newly pinned player costs one `GetPlayerSummaries` call for that player only, and the snapshot keeps its `fetchedAt`;
- an unpinned player disappears at once with no Steam call, because the response is built from the pinned list;
- a pinned account that Steam no longer knows is not asked for again until the snapshot expires.

Pinned players are ignored while the friends list is public.

`POST /api/steam/friends/pinned` with `{ "player": "<profile URL | 17-digit ID | vanity name>" }` pins a player and returns `{ player, pinned }`. `DELETE /api/steam/friends/pinned?steamid=<id>` unpins and returns `{ pinned }`. Both need a session and a same-origin request, and share a per-user (10 burst, 10 a minute) and per-IP (30 burst, 30 a minute) limit; errors use the standard envelope from `route-guards`. A player who cannot be found, the user themselves, invalid input and the limit of 50 pins come back as 400 `invalid` with a message; Steam failures are 502. The player must exist on Steam when pinned. Adding the friend dashboard's "add player" box is that package's job.

## `getLibraryFor(ids)`

Returns one `FriendLibrary` per Steam ID, in the order asked, repeated ids once: `{ steamId, state, source, games, fetchedAt }`. `games` is a `Map<appid, LibIndexEntry>` (`n`, `i`, `p`, `w`, `r`), empty unless `state` is `ok`. It throws only for invalid input (an id that is not 17 digits, or more than 50 ids); every problem with a player's library is a state, so one private profile never fails a group.

| State | Meaning |
|---|---|
| `ok` | the library was read |
| `private` | the profile or its Game details are private; Steam gives QIT no access, even for a lobby member |
| `not_found` | Steam knows no such profile |
| `error` | Steam failed or rate limited, or the daily key budget ran out; try again later |

Where a library comes from, in this order:

1. **QIT users** (`source: 'qit'`): a `users/{id}` document exists, its `public` flag is not `false`, and the library index is built. This costs one read for the user and four for the index chunks, and no Steam call. The `public` flag is only what the last sign-in saw; when it says private, Steam is asked instead of trusting an older index.
2. **The `publicLibraries` cache** (`source: 'steam'`): a document that has not expired.
3. **Live from Steam** (`source: 'steam'`): `GetPlayerSummaries` (no profile is `not_found`, a non-public profile is `private`), then `GetOwnedGames`. Live fetches are spread by the client's concurrency limit, and concurrent calls for one player share one fetch.

Cache lifetimes: 30 minutes for a library (D10, `PUBLIC_LIBRARY_TTL_MS`), 5 minutes for `private` and `not_found` (`NEGATIVE_TTL_MS`, so a friend who fixes their privacy settings is not stuck for half an hour) and 1 minute for `error` (`ERROR_TTL_MS`, to stop a retry storm while Steam is down). Readers check `expiresAt` themselves; Firestore TTL deletion is only housekeeping, and an expired library is never served. Non-QIT libraries live only in this cache (D10).

**Cache format.** `publicLibraries/{id}` stores the games as one JSON string of `[appid, name, icon, playtime, playtime2Weeks, lastPlayed]` rows (`encodeGames`, `decodeGames`), not as a map. Every map key and subfield of a document gets its own index entries, so a 2,000-game map would pass the 40,000 index entries per document, as the store-layer notes for the library index. A string costs two entries whatever the size, and 8,000 games with typical names take about 0.8 MiB. A library too big for one document is returned to the caller but not cached. `PublicLibraryRecord` in `src/lib/store/types.ts` changed accordingly (`games` is a string), as did `FriendsMetaRecord` (a full `FriendSummaryRecord`); no other module used them yet.

## `/api/games/friend`

Now reads through `getLibraryFor([id])`, so a QIT friend is answered from the index and a repeat lookup from the 30-minute cache, and each signed-in user gets a burst of 20 lookups and then one every 3 seconds (per instance, like every limiter in the repo). A limited request gets 429 with `Retry-After`. The response is still `{ games: [{ appid, name, img_icon_url, playtime_forever }] }` with plain `{ error }` messages, which `GamesList` reads; only the 429 is new. Status codes are unchanged: 404 not found, 403 private, 502 error.

## Notes for later packages

- Friend Night, the lobby and the dashboard should call `getLibraryFor` and never Steam directly, so the QIT shortcut, the 30-minute cache and the states apply everywhere.
- `getLibraryFor` returns `LibIndexEntry` maps, ready for `group-intersection` and the `Candidate` builders. `r` is kept as Steam sent it: a `0` next to `p > 0` means unknown, and `qit-steam-client.md` records that some accounts never return `rtime_last_played` at all.
- `getFriends` needs no Steam ID list from the caller. The dashboard can read `currentGame` and `status` from it directly.

## Tests

- `tests/qit-friends-data.test.ts` (`npm test`): the snapshot, TTL, batching, pinned fallback and partial refresh, stale and failure handling, pinning input forms and limits, `getLibraryFor` states, caching and TTLs, cache encoding and the size guard, using an in-memory `SocialStore` and a fake Steam.
- `tests/qit-friends-data.routes.test.ts` (`npm test`): the three routes, including authentication, origin check, status mapping and both rate limits.
- `tests/qit-friends-data.emulator.test.ts` (`npm run test:firestore`, needs Java): the Firestore store: snapshot and pinned documents, pinned edits in transactions, QIT libraries from the real index, an 8,000-game library cached in one document, an oversized library skipped, and a malformed cache document ignored.
- The friend suggestion tests that used to sit in `tests/routes.test.ts` moved to these files because the route no longer has an in-memory cache to test through `fetch`.
