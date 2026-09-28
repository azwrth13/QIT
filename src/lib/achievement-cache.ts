import { db } from './firestore';
import { getAchievementProgress, type AchievementProgress } from './steam';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export async function getCachedAchievementProgress(steamId: string, appid: number): Promise<AchievementProgress | null> {
  const ref = db.collection('users').doc(steamId).collection('achievementProgress').doc(String(appid));
  const snapshot = await ref.get();
  const cached = snapshot.data();
  const fetchedAt = typeof cached?.fetchedAt === 'string' ? Date.parse(cached.fetchedAt) : 0;
  if (Number.isFinite(fetchedAt) && fetchedAt > Date.now() - CACHE_TTL_MS && cached && 'progress' in cached) {
    return cached.progress as AchievementProgress;
  }
  const progress = await getAchievementProgress(steamId, appid);
  // Cache a null result too, so games without achievements/private stats do not
  // trigger a Steam API call every time the picker selects them.
  await ref.set({ progress, fetchedAt: new Date().toISOString() });
  return progress;
}
