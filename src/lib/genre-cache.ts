import { db } from './firestore';

const DAY = 24 * 60 * 60 * 1000;

export async function getGenresForApps(appids: number[], fillLimit = 40): Promise<Record<number, string[]>> {
  const ids = [...new Set(appids)];
  const genres: Record<number, string[]> = {};
  const missing: number[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const refs = ids.slice(offset, offset + 100).map(id => db.collection('apps').doc(String(id)));
    if (!refs.length) continue;
    const snapshots = await db.getAll(...refs);
    for (let i = 0; i < snapshots.length; i++) {
      const cached = snapshots[i].data();
      if (cached && typeof cached.fetchedAt === 'string' && Date.now() - Date.parse(cached.fetchedAt) < DAY) {
        genres[ids[offset + i]] = cached.genres || [];
      } else missing.push(ids[offset + i]);
    }
  }
  for (let offset = 0; offset < Math.min(missing.length, fillLimit); offset += 4) {
    await Promise.all(missing.slice(offset, Math.min(offset + 4, fillLimit)).map(async id => {
      try {
        const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=us`, {
          signal: AbortSignal.timeout(10000), cache: 'no-store',
        });
        if (!response.ok) return;
        const data = await response.json();
        const list: string[] = data[id]?.success
          ? (data[id].data?.genres || []).map((entry: { description: string }) => entry.description).filter(Boolean) : [];
        genres[id] = list;
        await db.collection('apps').doc(String(id)).set({ genres: list, fetchedAt: new Date().toISOString() });
      } catch { /* A failed Store lookup can be retried on the next request. */ }
    }));
    if (offset + 4 < Math.min(missing.length, fillLimit)) await new Promise(resolve => setTimeout(resolve, 300));
  }
  return genres;
}
