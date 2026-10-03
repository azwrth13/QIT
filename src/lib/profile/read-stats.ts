import { db } from '../firestore';
import { readStats } from '../history/stats';
import { readLibIndex } from '../store/lib-index';
import { paths } from '../store/paths';
import { deriveProfileStats } from './stats';

export async function readProfileStats(steamId: string) {
  const [summary, library, user] = await Promise.all([
    readStats(steamId), readLibIndex(steamId), db.doc(paths.user(steamId)).get(),
  ]);
  return deriveProfileStats({ ...library, playtimeHidden: user.get('flags.playtimeHidden') === true }, summary);
}
