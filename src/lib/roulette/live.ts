import { getCurrentPlayers, liveSignalsOf, PLAYER_BATCH_LIMIT } from '../apps/live-players';
import { isExpired } from '../store/converters';
import { readAppLive } from '../store/app-live';
import { logServerError } from '../steam';
import type { SignalLoader } from './pipeline';

/** Bound cache reads and live refreshes; compute relative bands together across the known pool. */
export const loadLive: SignalLoader = async (candidates, ctx) => {
  const wanted = [...candidates].sort((a, b) => Number(b.signals.store?.flags.multiplayer === true)
    - Number(a.signals.store?.flags.multiplayer === true) || b.signals.library.playtimeForever - a.signals.library.playtimeForever
    || a.appid - b.appid).slice(0, 1000);
  const players = new Map<number, number | null>();
  for (const candidate of candidates) {
    const count = candidate.signals.live?.players;
    if (count === null || typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) players.set(candidate.appid, count);
  }
  try {
    const cached = await readAppLive(wanted.map(candidate => candidate.appid));
    for (const [appid, record] of cached) {
      if (!isExpired(record.expiresAt, ctx.now) && (record.players === null
        || Number.isSafeInteger(record.players) && record.players >= 0)) players.set(appid, record.players);
    }
  } catch (error) { logServerError('Live cache read failed', error); }
  if (ctx.fetch) {
    const pending = wanted.filter(candidate => !players.has(candidate.appid)).slice(0, PLAYER_BATCH_LIMIT);
    if (pending.length) {
      try {
        const refreshed = await getCurrentPlayers(pending.map(candidate => candidate.appid), { now: ctx.now });
        for (const [appid, count] of refreshed.players) players.set(appid, count);
      } catch (error) { logServerError('Live enrichment failed', error); }
    }
  }
  const signals = liveSignalsOf(players);
  for (const candidate of candidates) {
    const live = signals.get(candidate.appid);
    if (live) candidate.signals.live = live;
  }
};
