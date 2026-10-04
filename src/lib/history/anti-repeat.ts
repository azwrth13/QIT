import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../firestore';
import { paths } from '../store/paths';
import { THRESHOLDS } from '../roulette/thresholds';

// Preferences for the anti-repeat window (Decision D6). Users can choose off (0), 7, 30, or 90 days.
// Stored per user at `users/{steamId}/prefs/antiRepeat`.

export const ANTI_REPEAT_OPTIONS = THRESHOLDS.antiRepeatDayOptions;
export const DEFAULT_ANTI_REPEAT_DAYS = THRESHOLDS.antiRepeatDays;

export function isValidAntiRepeatDays(value: unknown): value is number {
  return typeof value === 'number' && (ANTI_REPEAT_OPTIONS as readonly number[]).includes(value);
}

export async function getAntiRepeatDays(steamId: string): Promise<number> {
  const ref = db.doc(paths.antiRepeat(steamId));
  const doc = await ref.get();
  if (!doc.exists) return DEFAULT_ANTI_REPEAT_DAYS;
  const days = doc.get('days');
  return isValidAntiRepeatDays(days) ? days : DEFAULT_ANTI_REPEAT_DAYS;
}

export async function setAntiRepeatDays(steamId: string, days: number): Promise<number> {
  if (!isValidAntiRepeatDays(days)) {
    throw new Error(`Anti-repeat window must be one of: ${ANTI_REPEAT_OPTIONS.join(', ')} days`);
  }
  const ref = db.doc(paths.antiRepeat(steamId));
  await ref.set(
    {
      days,
      updatedAt: Timestamp.now(),
    },
    { merge: true },
  );
  return days;
}
