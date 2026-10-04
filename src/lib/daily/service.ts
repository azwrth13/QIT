import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { stageEvent } from '../history/events';
import { endOfLocalDay, isValidTimeZone, localDate } from '../history/time';
import { DEFAULT_DEPS, modesCatalog } from '../roulette/service';
import type { PipelineDeps } from '../roulette/pipeline';
import { stripUndefined } from '../store/converters';
import { paths } from '../store/paths';
import { runTransaction } from '../store/tx';
import { canAct, DEFAULT_DAILY_SETTINGS, parseDailySettings, type DailyAction, type DailyResponse, type DailySelection, type DailySettings, type DailyView } from './model';
import { drawDaily } from './selection';

// All Daily state lives in its date-keyed records. Roulette rolls remain owned by history/rolls.ts.
// Preferences are a field of the existing user record, avoiding a new shared path contract.
export class DailyConflict extends Error {}
export class DailyInputError extends Error {}

export function dailyModes() { return modesCatalog().modes.filter(mode => mode.scopes.includes('library')); }
const validSettings = (value: unknown) => {
  const settings = parseDailySettings(value);
  return settings && (settings.mode === 'backlog-mix' || dailyModes().some(mode => mode.id === settings.mode)) ? settings : null;
};

async function profileContext(steamId: string, now: number) {
  const profile = await db.doc(paths.user(steamId)).get();
  if (!profile.exists) throw new DailyInputError('Sync your Steam profile first');
  const tz = isValidTimeZone(profile.get('tz')) ? profile.get('tz') as string : 'UTC';
  const settings = validSettings(profile.get('dailySettings')) ?? { ...DEFAULT_DAILY_SETTINGS };
  return { tz, settings, date: localDate(now, tz) };
}

// Persist time as Timestamp, expose milliseconds. Missing optional enrichment stays null in the saved card.
function storedSelection(selection: DailySelection) {
  return stripUndefined({ ...selection, selectedAt: Timestamp.fromMillis(selection.selectedAt) });
}
function storedDaily(daily: DailyView) {
  return { ...daily, selection: storedSelection(daily.selection), previous: daily.previous.map(storedSelection),
    decidedAt: daily.decidedAt === null ? null : Timestamp.fromMillis(daily.decidedAt) };
}
function readSelection(raw: Record<string, unknown>): DailySelection {
  return { ...raw, selectedAt: raw.selectedAt instanceof Timestamp ? raw.selectedAt.toMillis() : 0 } as DailySelection;
}
export function readDaily(raw: Record<string, unknown> | undefined): DailyView | null {
  if (!raw || typeof raw.date !== 'string' || !raw.selection || typeof raw.selection !== 'object') return null;
  return { ...raw, selection: readSelection(raw.selection as Record<string, unknown>),
    previous: Array.isArray(raw.previous) ? raw.previous.map(readSelection) : [],
    decidedAt: raw.decidedAt instanceof Timestamp ? raw.decidedAt.toMillis() : null } as DailyView;
}

/** Single range/index, at most 92 daily records. Include all rerolled snapshots in the anti-repeat history. */
async function withDailyHistory(steamId: string, now: number, deps: PipelineDeps): Promise<PipelineDeps> {
  const since = localDate(now - 91 * 86_400_000, 'UTC');
  const snapshot = await db.collection(paths.dailies(steamId)).where('date', '>=', since)
    .orderBy('date', 'desc').limit(92).get();
  const selections = snapshot.docs.flatMap(doc => {
    const daily = readDaily(doc.data());
    return daily ? [...daily.previous, daily.selection] : [];
  }).filter(selection => selection.card && selection.selectedAt <= now);
  return { ...deps, loaders: { ...deps.loaders, history: async (candidates, ctx) => {
    await deps.loaders.history?.(candidates, ctx);
    const window = Math.max(30, (ctx.filters.find(({ filter }) => filter.id === 'exclude-rolled')?.params as { days?: number })?.days ?? 0);
    for (const candidate of candidates) {
      const daily = selections.filter(selection => selection.card!.appid === candidate.appid && selection.selectedAt >= now - window * 86_400_000);
      if (!daily.length) continue;
      const history = candidate.signals.history;
      candidate.signals.history = { timesRolled: (history?.timesRolled ?? 0) + daily.length,
        lastRolledAt: Math.max(history?.lastRolledAt ?? 0, ...daily.map(selection => Math.floor(selection.selectedAt / 1000))),
        excluded: history?.excluded ?? null, playedAfterRoll: history?.playedAfterRoll ?? false };
    }
  } } };
}

function stageSelectionEvent(tx: Parameters<typeof stageEvent>[0], steamId: string, daily: DailyView, now: number) {
  const card = daily.selection.card;
  if (card) stageEvent(tx, steamId, { type: 'daily_roll', appid: card.appid, refId: daily.date,
    meta: { modeId: card.modeId, rerolls: daily.rerolls } }, now);
}

/** First read creates the day. Steam work stays outside the retryable transaction; only the winning snapshot emits an event. */
export async function getToday(steamId: string, now = Date.now(), deps = DEFAULT_DEPS): Promise<DailyResponse> {
  const { tz, date, settings } = await profileContext(steamId, now);
  const ref = db.doc(paths.daily(steamId, date));
  let today = readDaily((await ref.get()).data());
  if (!today) {
    const selection = await drawDaily(steamId, date, 0, settings, [], now, await withDailyHistory(steamId, now, deps));
    const proposed: DailyView = { date, tz, settings, status: selection.card ? 'ready' : 'empty', rerolls: 0, selection, previous: [], decidedAt: null };
    today = await runTransaction(async tx => {
      const existing = await tx.get(ref);
      if (existing.exists) {
        const saved = readDaily(existing.data());
        if (!saved) throw new Error('Invalid saved daily');
        return saved;
      }
      tx.create(ref, storedDaily(proposed));
      stageSelectionEvent(tx, steamId, proposed, now);
      return proposed;
    });
  }
  return { today, tz, settings, now, nextDayAt: endOfLocalDay(now, tz) };
}

/** Settings affect the next day, preserving today's mode and anti-repeat rules through its rerolls. */
export async function saveDailySettings(steamId: string, raw: unknown): Promise<DailySettings> {
  const settings = validSettings(raw);
  if (!settings) throw new DailyInputError('Choose an available library mode and an anti-repeat window of off, 7, 30 or 90 days');
  await db.doc(paths.user(steamId)).update({ dailySettings: settings });
  return settings;
}

/** The expected date and reroll revision prevent stale tabs or retried HTTP calls from deciding a different pick. */
export async function actOnDaily(steamId: string, action: DailyAction, date: string, revision: number,
  now = Date.now(), deps = DEFAULT_DEPS): Promise<DailyResponse> {
  const context = await profileContext(steamId, now);
  if (date !== context.date) throw new DailyConflict('A new local day has started. Reload today’s pick.');
  const ref = db.doc(paths.daily(steamId, date));
  const before = readDaily((await ref.get()).data());
  if (!before || before.rerolls !== revision) throw new DailyConflict('This pick changed. Reload today’s pick.');
  if ((action === 'accept' && before.status === 'accepted') || (action === 'played' && before.status === 'played') || (action === 'skip' && before.status === 'skipped')) {
    return { today: before, tz: context.tz, settings: context.settings, now, nextDayAt: endOfLocalDay(now, context.tz) };
  }
  if (!canAct(before, action)) throw new DailyConflict('This daily action is no longer available');
  const exclude = [...before.previous, before.selection].flatMap(selection => selection.card ? [selection.card.appid] : []);
  const selection = action === 'reroll' ? await drawDaily(steamId, date, revision + 1, before.settings, exclude, now,
    await withDailyHistory(steamId, now, deps)) : null;
  const today = await runTransaction(async tx => {
    const current = readDaily((await tx.get(ref)).data());
    if (!current || current.rerolls !== revision) throw new DailyConflict('This pick changed. Reload today’s pick.');
    if ((action === 'accept' && current.status === 'accepted') || (action === 'played' && current.status === 'played') || (action === 'skip' && current.status === 'skipped')) return current;
    if (!canAct(current, action)) throw new DailyConflict('This daily action is no longer available');
    // A concurrent accept must not be overwritten by a reroll prepared for a ready pick.
    if (action === 'reroll' && current.status !== before.status) throw new DailyConflict('This pick changed. Reload today’s pick.');
    const next: DailyView = selection ? { ...current, status: selection.card ? 'ready' : 'empty', rerolls: revision + 1,
      previous: [...current.previous, current.selection], selection, decidedAt: null }
      : { ...current, status: action === 'accept' ? 'accepted' : action === 'played' ? 'played' : 'skipped', decidedAt: now };
    tx.set(ref, storedDaily(next));
    stageEvent(tx, steamId, { type: action === 'accept' ? 'daily_accept' : `daily_${action}`,
      refId: date, ...(current.selection.card ? { appid: current.selection.card.appid } : {}),
      meta: { modeId: current.selection.card?.modeId ?? current.settings.mode, source: 'manual', playtimeAtRoll: current.selection.playtimeAtRoll } }, now);
    if (selection) stageSelectionEvent(tx, steamId, next, now);
    return next;
  });
  return { today, tz: context.tz, settings: context.settings, now, nextDayAt: endOfLocalDay(now, context.tz) };
}

export async function dailyHistory(steamId: string, cursor?: string) {
  let query = db.collection(paths.dailies(steamId)).orderBy('date', 'desc');
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.limit(20).get();
  return { dailies: snapshot.docs.map(doc => readDaily(doc.data())).filter((daily): daily is DailyView => daily !== null),
    nextCursor: snapshot.size === 20 ? snapshot.docs.at(-1)!.id : null };
}
