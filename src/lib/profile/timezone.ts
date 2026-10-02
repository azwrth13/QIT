import { db } from '../firestore';
import { paths } from '../store/paths';
import { runTransaction } from '../store/tx';
import { isValidTimeZone } from '../history/time';

/** Captures the browser timezone once. Never overwrites an existing valid zone; returns the stored zone. */
export async function setProfileTimeZone(steamId: string, tz: string): Promise<string | null> {
  if (!isValidTimeZone(tz)) throw new Error('Invalid IANA timezone');
  return runTransaction(async tx => {
    const ref = db.doc(paths.user(steamId));
    const profile = await tx.get(ref);
    if (!profile.exists) return null;
    const current = profile.get('tz');
    if (isValidTimeZone(current)) return current;
    tx.update(ref, { tz });
    return tz;
  });
}
