import type { Card, ModeId, SpinResponse } from '../roulette/types';
import { isModeId } from '../roulette/modes';

export const DAILY_REROLL_LIMIT = 3;
export const ANTI_REPEAT_OPTIONS = [0, 7, 30, 90] as const;
export type DailySettings = { mode: ModeId | 'backlog-mix'; antiRepeatDays: number };
export const DEFAULT_DAILY_SETTINGS: DailySettings = { mode: 'backlog-mix', antiRepeatDays: 30 };
export type DailyStatus = 'ready' | 'accepted' | 'played' | 'skipped' | 'empty';
export type DailyAction = 'accept' | 'reroll' | 'skip' | 'played';
export interface DailySelection {
  card: Card | null;
  seed: string;
  poolSize: number;
  coverage: SpinResponse['coverage'];
  playtimeAtRoll: number | null;
  selectedAt: number;
}
export interface DailyView {
  date: string;
  tz: string;
  settings: DailySettings;
  status: DailyStatus;
  rerolls: number;
  selection: DailySelection;
  previous: DailySelection[];
  decidedAt: number | null;
}
export interface DailyResponse {
  today: DailyView | null;
  settings: DailySettings;
  tz: string;
  now: number;
  nextDayAt: number;
}

export function parseDailySettings(raw: unknown): DailySettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['mode', 'antiRepeatDays'].includes(key))) return null;
  if (value.mode !== 'backlog-mix' && !isModeId(value.mode)) return null;
  if (!(ANTI_REPEAT_OPTIONS as readonly unknown[]).includes(value.antiRepeatDays)) return null;
  return { mode: value.mode, antiRepeatDays: value.antiRepeatDays as number };
}

/** Terminal picks cannot be reopened. Empty picks can be retried within the same daily cap. */
export function canAct(daily: DailyView, action: DailyAction): boolean {
  if (daily.status === 'played' || daily.status === 'skipped') return false;
  if (action === 'reroll') return daily.rerolls < DAILY_REROLL_LIMIT;
  if (action === 'skip') return true;
  return daily.selection.card !== null && (action === 'played' || daily.status === 'ready');
}
