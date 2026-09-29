import { enrichLibraryFlags, getAppMeta, storeSignalsOf } from '../apps/metadata';
import { readExclusions } from '../history/exclusions';
import { recentlyRolled } from '../history/rolls';
import { logServerError } from '../steam';
import { readLibIndex } from '../store/lib-index';
import type { ExcludeRolledParams } from './filters/exclude-rolled';
import type { LoadContext, SignalLoaders } from './pipeline';
import { storeSignalsFromBits } from './scopes/library';
import { THRESHOLDS } from './thresholds';
import type { Candidate } from './types';

// Signal loaders for the spin pipeline. `library` comes from the scope resolver, and the library scope also attaches
// `store` and `achievements` from the library index. Here:
//
// - `history`: the requester's active exclusions (one read) and recent rolls (one range query), for every candidate.
// - `store`: bounded enrichment for games whose store flags are not known yet, through app-metadata's writers so the
//   answers are cached for the next spin. Pool previews (`fetch: false`) never call Steam.
//
// `achievements`, `live` and `group` have no loader yet: their packages (qit-achievements-data, qit-player-counts,
// the group scopes) add one here. Until then those signals are unknown and `coverage` says so.

/** Apps sent to Steam's GetItems per spin: 100 per call, so at most 5 calls, which run at once (concurrency 5). */
export const STORE_ENRICH_MAX_APPS = 500;
/** Cached `appMeta` documents read per spin, in any scope. */
export const STORE_ENRICH_MAX_READS = 1000;

/** The cheap prior for store enrichment: most played first (then most recently played), so the games a player knows get checked first. */
export function byEnrichPrior(a: Candidate, b: Candidate): number {
  const x = a.signals.library, y = b.signals.library;
  return y.playtimeForever - x.playtimeForever || (y.lastPlayedAt ?? 0) - (x.lastPlayedAt ?? 0) || a.appid - b.appid;
}

/** Days of rolls to load: the anti-repeat filter's window if it asks for a longer one, otherwise the default (D6). */
export function historyWindowDays(ctx: Pick<LoadContext, 'filters'>): number {
  const excludeRolled = ctx.filters.find(({ filter }) => filter.id === 'exclude-rolled');
  const days = (excludeRolled?.params as ExcludeRolledParams | undefined)?.days ?? 0;
  return Math.max(days, THRESHOLDS.antiRepeatDays);
}

async function loadHistory(candidates: Candidate[], ctx: LoadContext): Promise<void> {
  const [exclusions, recent] = await Promise.all([
    readExclusions(ctx.steamId, { sessionId: ctx.sessionId, now: ctx.now }),
    recentlyRolled(ctx.steamId, { days: historyWindowDays(ctx), now: ctx.now }),
  ]);
  for (const candidate of candidates) {
    const rolled = recent.get(candidate.appid);
    candidate.signals.history = {
      timesRolled: rolled?.count ?? 0,
      lastRolledAt: rolled?.lastRolledAt ?? null,
      excluded: exclusions.get(candidate.appid)?.scope ?? null,
      // Filled by qit-played-detection once it lands; nothing reads it yet.
      playedAfterRoll: false,
    };
  }
}

async function loadStore(candidates: Candidate[], ctx: LoadContext): Promise<void> {
  const missing = candidates.filter(candidate => !candidate.signals.store);
  if (!missing.length || !ctx.fetch) return;
  const wanted = missing.sort(byEnrichPrior).slice(0, STORE_ENRICH_MAX_READS);
  // Unknown store data only leaves filters unknown and non-games unhidden, so a failure here never fails the spin.
  try {
    if (ctx.scope.kind === 'library') {
      // Patches the flag bits into the index (app-metadata is their only writer), then reads them back.
      await enrichLibraryFlags(ctx.steamId, { appids: wanted.map(candidate => candidate.appid), maxFetch: STORE_ENRICH_MAX_APPS });
      const index = await readLibIndex(ctx.steamId);
      for (const candidate of wanted) {
        const bits = index.entries.get(candidate.appid)?.f;
        if (typeof bits === 'number') candidate.signals.store = storeSignalsFromBits(bits);
      }
      return;
    }
    const { meta } = await getAppMeta(wanted.map(candidate => candidate.appid), { maxFetch: STORE_ENRICH_MAX_APPS });
    for (const candidate of wanted) {
      const app = meta.get(candidate.appid);
      if (app) candidate.signals.store = storeSignalsOf(app);
    }
  } catch (error) {
    logServerError('Store enrichment failed', error);
  }
}

export const SIGNAL_LOADERS: SignalLoaders = {
  history: loadHistory,
  store: loadStore,
};
