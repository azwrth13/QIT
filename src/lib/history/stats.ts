import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { paths } from '../store/paths';
import type { StatsSummaryRecord } from '../store/types';
import type { EventInput } from './events';
import { runTransaction } from '../store/tx';
import { isValidTimeZone, localDate } from './time';
import { calculateProgression, QUALIFYING_ACTIONS, type Progression, type ProgressionEvent } from './progression';

// The only writer of `users/{id}/stats/summary`. Counters move only as a side effect of `recordEvent`, in the
// same transaction as the event, so they never drift from the event log. Increments are blind merge writes,
// so appending an event does not require a summary read. The cached progression is refreshed on read.

/** For these event types, one `meta` field also gets a per-value counter, for example `roll:modeId:dust-collector`. */
export const COUNTER_DIMENSIONS: Readonly<Record<string, string>> = Object.freeze({
  roll: 'modeId',
  accept: 'modeId',
  played: 'source',
  exclude: 'scope',
  challenge_complete: 'kind',
});

const DIMENSION_VALUE = /^[a-z0-9_-]{1,40}$/;

/** Counter keys an event increments: always its type, plus `type:field:value` for a dimension. Pure. */
export function countersFor(event: Pick<EventInput, 'type' | 'meta'>): string[] {
  const keys = [event.type];
  const field = COUNTER_DIMENSIONS[event.type];
  const value = field ? event.meta?.[field] : undefined;
  if (typeof value === 'string' && DIMENSION_VALUE.test(value)) keys.push(`${event.type}:${field}:${value}`);
  return keys;
}

const summaryRef = (steamId: string) => db.doc(paths.statsSummary(steamId));

/** Stages the counter increments for `event` in `tx`. Called only by `events.ts`. */
export function applyEventToStats(tx: Transaction, steamId: string, event: Pick<EventInput, 'type' | 'meta'>, at: Timestamp): void {
  const counters = Object.fromEntries(countersFor(event).map(key => [key, FieldValue.increment(1)]));
  tx.set(summaryRef(steamId), { counters, updatedAt: at, eventRevision: FieldValue.increment(1) }, { merge: true });
}

export interface StatsSummary {
  counters: Record<string, number>;
  streak: StatsSummaryRecord['streak'] | null;
  updatedAt: Date | null;
  progression: Progression;
}

/** Cached projection, rebuilt transactionally when events, profile timezone, or calendar day change.
 * Only this module writes summary fields; event writers keep their existing atomic blind increments.
 */
export async function readStats(steamId: string, now = Date.now()): Promise<StatsSummary> {
  return runTransaction(async tx => {
    const [summary, profile] = await tx.getAll(summaryRef(steamId), db.doc(paths.user(steamId)));
    const data = summary.data();
    const tz = isValidTimeZone(profile.get('tz')) ? profile.get('tz') as string : 'UTC';
    const day = localDate(now, tz);
    const revision = data?.eventRevision ?? 0;
    const cached = data?.progressionCache;
    let progression: Progression;
    if (cached?.revision === revision && cached?.tz === tz && cached?.day === day && cached?.at <= now && (cached?.nextEventAt === null || now < cached?.nextEventAt)) {
      progression = cached.value as Progression;
    } else {
      const snapshots = await tx.get(db.collection(paths.events(steamId)).where('type', 'in', Object.keys(QUALIFYING_ACTIONS)));
      const events: ProgressionEvent[] = snapshots.docs.flatMap(doc => {
        const event = doc.data();
        return event.at instanceof Timestamp ? [{ ...event, id: doc.id, at: event.at.toMillis() } as ProgressionEvent] : [];
      });
      // Events predating this package did not snapshot playtime. Resolve only their referenced rolls.
      const legacy = events.filter(event => event.type === 'played' && event.refId && event.meta?.playtimeAtRoll === undefined);
      const ids = [...new Set(legacy.map(event => event.refId!))];
      const playtime = new Map<string, unknown>();
      for (let offset = 0; offset < ids.length; offset += 100) {
        const rolls = await tx.getAll(...ids.slice(offset, offset + 100).map(id => db.doc(paths.roll(steamId, id))));
        for (const roll of rolls) playtime.set(roll.id, roll.get('playtimeAtRoll'));
      }
      for (const event of legacy) event.meta = { ...event.meta, playtimeAtRoll: playtime.get(event.refId!) };
      progression = calculateProgression(events, tz, now);
      const nextEventAt = events.reduce<number | null>((next, event) =>
        event.at <= now ? next : next === null ? event.at : Math.min(next, event.at), null);
      tx.set(summaryRef(steamId), {
        streak: { current: progression.current, longest: progression.longest, ...(progression.lastDay ? { lastDay: progression.lastDay } : {}) },
        progressionCache: { revision, tz, day, at: now, nextEventAt, value: progression },
      }, { mergeFields: ['streak', 'progressionCache'] });
    }
    const counters: Record<string, number> = {};
    if (data?.counters && typeof data.counters === 'object') {
      for (const [key, value] of Object.entries(data.counters as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) counters[key] = value;
      }
    }
    return {
      counters,
      streak: progression.lastDay ? { current: progression.current, longest: progression.longest, lastDay: progression.lastDay } : null,
      progression,
      updatedAt: data?.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : null,
    };
  });
}
