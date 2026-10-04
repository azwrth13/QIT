# Privacy policy and data controls

`/privacy` is a public, dynamic page with an account-data panel for signed-in users. Only the privacy nav flag is enabled; the footer links to it. No hosting, short-link or session implementation changes.

## Interfaces

- `POST /api/user/data/export`: signed-in caller only, JSON attachment, `private, no-store`, `Vary: Cookie`. Version 1 contains the user's document tree (relative paths, `.` is the profile), their public-library cache, their hashed creation-limit record and their own lobby member entries. Shared lobby libraries and other members are not exported. Stored friend snapshots and participant references belong to the caller's tree and remain in that export. Firestore timestamps use the Admin SDK JSON representation. The export is not a transactionally consistent snapshot.
- `POST /api/user/data/delete`: signed-in caller only, JSON `{ "confirmation": "DELETE MY DATA" }`. The UI requires typing that phrase. Removes memberships (including expired/closed lobbies), transfers host to a remaining member, removes votes/vetoes and clears the old result, rebuilds common chunks using remaining members' stored public QIT indexes without Steam requests. If an index is unavailable, clears the common cache instead of keeping deleted-user signals; a later membership change can refresh it. Empty lobbies close. Removes the caller's public-library cache and hashed creation bucket, then recursively deletes the entire user tree, including future/unknown subcollections and missing ancestors. Clears `__session` on success. Failures retain the session so the user can retry; completed batches and memberships are idempotent.
- Both POSTs require the existing Origin/Referer guard and use per-user/per-IP token buckets. Export: user capacity 2, one refill/minute; delete: capacity 3, one refill/minute. Errors go through `logServerError` and a generic safe response.
- Deletes use the shared 450-write batch helper (Firestore's limit is 500). Descendants precede parents; `listDocuments` discovers orphan descendants as well as extant documents. Lobby chunk replacement stays within the existing 200-chunk and 4 MB caps.

## Actual storage inventory

This inventory follows writers in `library-data`, `library/index`, `store/lib-index`, `achievements/store`, `social/store`, `history/*`, `apps/*`, `genre-cache`, `lobby/service` and the search/session code. Timestamps may be legacy ISO strings or Firestore Timestamps as noted by their owning types. Freshness/expiry never implies synchronous physical erasure.

| Path | Fields written | Retention/use |
| --- | --- | --- |
| `users/{id}` | `steamId`, `personaName`, `profileUrl`, `avatarFull`, `avatarMedium`, `public`, `lastSyncedAt`, `tz`, `flags.playtimeHidden` (friendsListPublic is a declared optional contract, not currently written) | Until deletion; profile refreshed at sign-in/sync |
| `users/{id}/games/{appid}` | `appid`, `name`, `img_icon_url`, `playtime_forever`, `playtime_2weeks`, `rtime_last_played`, `has_community_visible_stats` | Until deletion or game removal on sync |
| `users/{id}/libIndex/{chunk}` | `games` keyed by appid, entries `n` name, `i` icon, `p` total minutes, `w` two-week minutes, `r` last played seconds, `s` community stats, `f` store flags, `ap/au/at` achievement percent/unlocked/total; `updatedAt` | Same base library lifetime; refreshed/field-patched, not expired by age |
| `users/{id}/achievementProgress/{appid}` | `v`, `state`, `progress` (`unlocked,total,percent` or null), `locked` (`apiname,name?,description?`), `lockedTruncated`, `lastUnlockAt`, ISO `fetchedAt`, Timestamp `expiresAt`; legacy records may contain only progress/fetchedAt | Fresh 24 h unfinished, 30 d complete, 7 d no stats; kept until replacement/deletion |
| `users/{id}/meta/achievements` | `privateUntil` | Suppresses private-achievement requests for 1 h; document persists |
| `users/{id}/meta/friends` | `ids`, `summaries` keyed by friend ID (`name,url,avatar,avatarMedium?,status?,gameId?,game?`), `state`, `fetchedAt` | 15-minute freshness; persists until replacement/deletion |
| `users/{id}/meta/pinned` | `ids`, `updatedAt` | Until unpinned or deletion |
| `users/{id}/rolls/{rollId}` | `appid`, optional `name`, `modeId`, `filters`, `scope`, `participants`, optional `lobbyId`, `at`, `status`, optional `acceptedAt,rerolledAt,playedAt,playedSource`, `playtimeAtRoll`, `reasons` | No age-based deletion |
| `users/{id}/events/{eventId}` | `type`, `at`, optional `appid,refId,meta`; current metadata includes `modeId,scope,source,playtimeAtRoll,kind,threshold,from,unlocks` | Append-only, no age-based deletion |
| `users/{id}/prefs/exclusions` | map keyed by appid with `scope`, optional `until,sessionId`, `at` | Expired entries ignored/pruned during exclusion edits; permanent entries until unhidden/deletion |
| `users/{id}/stats/summary` | `counters`, `updatedAt`, `eventRevision`, optional `streak` (`current,longest,lastDay`), `progressionCache` (`revision,tz,day,at,nextEventAt,value` with current/longest/lastDay/gamesDiscovered/backlogGamesStarted/challengesCompleted/rareAchievementsCompleted) | Until deletion; derived cache refreshed as needed |
| `users/{id}/challenges/{id}` | `kind`, `appid`, `name?`, `apiname`, `achievementName?`, `achievementDescription?`, `threshold?`, `status`, `issuedAt`, optional `acceptedAt,completedAt,declinedAt,expiredAt`, `expiresAt`, optional `unlocks` (`apiname,unlocktime`) | Offers/attempts expire for use; records/history retained until deletion |
| `users/{id}/daily/{date}` | Declared `appid,modeId,status,rerolls,previous,decidedAt?`; no current writer | Reserved path; recursive controls handle it if present |
| `apps/{appid}` | `genres`, ISO `fetchedAt` | 1-day freshness, persists until refreshed |
| `appMeta/{appid}` | `type?,categories?,flags?,tagids?,release?,art?,review?,reviewPercent?,reviewCount?,parentAppid?`, `state`, `fetchedAt` | 7-day freshness, unknown 30 days; persistent shared app data |
| `appLive/{appid}` | `players` or null, `fetchedAt`, `expiresAt` | 10-minute freshness |
| `appCharts/concurrent` | `appids`, `fetchedAt`, `expiresAt` | 5-minute freshness |
| `appAchievements/{appid}` | Declared `percents` keyed by apiname, `fetchedAt`; no current Firestore writer | Reserved rarity path; not user-owned |
| `publicLibraries/{steamId}` | `state`, `games` JSON string (arrays of appid/name/icon/total minutes/two-week minutes/last played), `fetchedAt`, `expiresAt` | Successful libraries usable 30 min, private/not-found 5 min, errors 1 min; readers refuse expired data, but physical cleanup not guaranteed |
| `lobbies/{code}` | `hostId,createdAt,updatedAt,expiresAt,version,status,filters,members,commonCount,commonChunkCount,filteredCount,filterUnknownCount,rejected,votes,vetoes`; `result` reserved/currently not populated by core | 6 h idle expiry; no current automatic physical cleanup |
| lobby `members` | keyed by Steam ID: `name,avatar,state,libraryState,playtimeHidden,joinedAt` | Removed on leave/deletion; expired parent may still contain entries |
| `lobbies/{code}/common/{chunk}` | `games` deflate/base64 candidate JSON: appid; library name/icon/total and two-week minutes/last played; optional store flags and host achievement summary; group members (`steamId,owns,playtimeForever,playtime2Weeks,lastPlayedAt`) | Valid only for active lobby; rewritten on membership change; closed/expired chunks may persist unless removed by a mutation/deletion |
| `lobbyLimits/{kind}-{sha256(identity)}` | `tokens,updatedAt,expiresAt` | Creation identity is user ID, 1 h window; join identity is IP, 1 min window. Physical cleanup unspecified. Own creation record is included in export/deletion; IP bucket cannot be attributed to one user |

No deployed Firestore path for the optional Steam daily-budget helper is configured by this code. If wired in later, its contract stores `used,day,updatedAt,expiresAt` (two-day expiry) at an externally supplied reference. Do not claim it is live storage today.

Memory-only storage: public library responses cached 5 min; search results (Steam ID/name/profile/avatar/visibility/profile state, optional level and badge count, or error) cached 1 min, keyed by ID or vanity query; bounded per-IP/per-user request buckets; social in-flight request coalescing; temporary roulette/lobby computation results. These are per instance and disappear with process termination. Cookie `__session` is a sealed ID/expiry for up to 7 days, or validated sign-in return path/expiry for 10 min. No new cookies were added. Logging uses fixed context/error name and omits arbitrary errors/Steam payloads. Infrastructure access logs/backups and their retention are not established by the repository.

## Location and known release limitations

The project region supplied for this package is `us-central1` (Iowa, United States). The public policy names that region/country for application Firestore storage. Deployment operators must verify the live database location agrees; this package does not provision or change infrastructure.

The D10/section 7.3 mitigation goals are described without claiming unenforced deletion or disclosure restrictions:

- Non-QIT library cache has a 30-minute **use** lifetime; TTL configuration/cleanup is not guaranteed, so physical storage can exceed it. Lobbies similarly stop using data at expiry but leave documents/chunks. Strict physical retention requires follow-up operational cleanup before launch.
- Signed-in lobby joining opts members in. Public polling by code shows names/avatars. Common chunks contain intersections and individual playtime, with additional host signals internally.
- Existing `/api/games/friend` returns a whole friend's public library to the requester for browser-side intersection. The policy says this explicitly; it cannot honestly claim only intersections are ever disclosed. Tightening that endpoint belongs to its owning package, not this one. Public library pages intentionally expose public libraries.
- Deletion does not remove references from **other users'** friends/pins/rolls/events; tests require leaving other user trees untouched. Public data may later be requested and cached again.
- The existing stateless session scheme has no server revocation: clearing the response cookie ends this browser session, but another browser/copied cookie stays usable until expiry. Concurrent actions may repopulate documents; controls advise stopping other actions. Global revocation/write coordination needs an auth/store contract across all writers and is outside this package. The export is not atomic; very large histories can exceed hosting request duration or response limits. Batched deletion is retry-safe, not globally atomic.

These are documented release limitations, not additional changes to this package. No claim about sales, analytics, encryption at rest, backup deletion schedules or unverified infrastructure settings is invented.

## Verification

Emulator tests invoke the real endpoints with only authentication mocked. They cover caller-only exports, unknown/orphan descendants, more than 450 deletes, all known subcollections, another user's preservation, expired-lobby membership and playtime cleanup, host transfer/empty closure, session-cookie removal, repeated deletion, confirmation, authentication and Origin failures. Unit suite, typecheck and lint also run locally before handoff.
