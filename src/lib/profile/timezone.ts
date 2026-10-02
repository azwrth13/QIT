import { db } from '../firestore';
import { paths } from '../store/paths';
import { runTransaction } from '../store/tx';
import { isValidTimeZone } from '../history/time';

/** Profile settings writer. Automatic browser capture never overwrites an existing preference. */
export async function setProfileTimeZone(steamId: string, tz: string, onlyIfMissing = false): Promise<string | null> {
  if (!isValidTimeZone(tz)) throw new Error('Invalid IANA timezone');
  return runTransaction(async tx => {
    const ref = db.doc(paths.user(steamId));
    const profile = await tx.get(ref);
    if (!profile.exists) return null;
    const current = profile.get('tz');
    if (onlyIfMissing && isValidTimeZone(current)) return current;
    tx.update(ref, { tz });
    return tz;
  });
}
