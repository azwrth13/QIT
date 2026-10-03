# QIT profile statistics

`/profile` is a signed-in-only view of discovery and backlog usage. Its Stats navigation entry is enabled independently. Anonymous visitors see a Steam sign-in link; no statistics are fetched until signed in. The page offers loading, empty-library, unknown-playtime, error, and retry states.

`GET /api/profile/stats` authenticates through `getSteamId`, applies per-user/IP rate limits, and returns private, no-store JSON. A supplied Steam ID is ignored. Failures use the shared safe error envelope. The service reads the compact library index (four chunk reads), user playtime visibility, and `history/stats.ts`'s existing `readStats` projection. It never loads the full games collection or calls Steam. No new counters, event emitters, or summary writers were added; the existing stats service owns any progression cache refresh and legacy-event resolution.

| Statistic | Source / meaning |
| --- | --- |
| Games owned | Number of entries in the last synced compact index; unknown before an index exists |
| Never played | Entries with `p === 0`; unknown if playtime is hidden or any entry has unknown playtime |
| Games discovered through QIT | Existing progression `gamesDiscovered`: distinct recommended app IDs recorded as played |
| Backlog games started | Existing progression `backlogGamesStarted`: distinct played picks with zero playtime at recommendation |
| Dailies accepted | `counters.daily_accept`, zero when absent |
| Friend Nights completed | `counters.friend_night_played`, zero when absent |
| Challenges completed | Existing progression `challengesCompleted`, includes rare challenges |
| Rare achievements completed | Existing progression `rareAchievementsCompleted` (verified rare challenges) |
| Most-used roulette mode | Highest positive `roll:modeId:<registered-id>` counter; ties follow registry order; no picks means no mode |
| Recommended, then played | Existing distinct-game `gamesDiscovered` projection; explicitly the same set as discoveries, with repeat picks counted once |

Daily and Friend Night source packages have not landed in this baseline. Their counters remain zero until those packages emit their events; this page introduces no producers. The rare-challenge surface is also pending, while the existing challenge tracker/progression already supports rare completions. Missing counters and progression fields default to zero. Manual played confirmations and sync-detected playtime increases both contribute according to the existing played-detection/progression rules.

The library reflects the last sync, not a live Steam ownership query. Users whose compact index has not been built are prompted to sync; there is deliberately no per-game legacy fallback. Partial playtime does not masquerade as a complete never-played total. No public profile, leaderboard, standard Steam achievement totals, or profile-editing surface is included.

Tests cover empty and unbuilt indexes, known/unknown/hidden playtime, missing and invalid counters, unique progression versus repeated played events, mode ties, API authentication, session identity isolation, rate limits, failures, private caching, page auth gating, and navigation visibility.

Package-boundary note: the current sign-in return-path allow-list supports lobby links only, so signing in from this page follows the normal library landing. Users can then select Stats in the navigation. Auth/short-link files remain untouched.
