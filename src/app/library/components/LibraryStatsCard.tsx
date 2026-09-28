import type { Game } from '../../../lib/games';
import { getLibraryStats } from '../../../lib/games';
import BrowserWindow from '../../components/BrowserWindow';

export default function LibraryStatsCard({ games }: { games: Game[] }) {
  const stats = getLibraryStats(games);

  return <BrowserWindow title="LIBRARY STATS" className="mb-8">
    <div className="grid grid-cols-2 gap-4 text-black md:grid-cols-4">
      <div><p className="text-sm font-bold">Total playtime</p><p className="text-xl font-bold">{stats.totalHours} hours</p></div>
      <div><p className="text-sm font-bold">Never played</p><p className="text-xl font-bold">{stats.unplayedCount} ({stats.unplayedPercentage}%)</p></div>
      <div className="col-span-2 md:col-span-2"><p className="text-sm font-bold">Most played</p><p className="text-xl font-bold">{stats.mostPlayed ? `${stats.mostPlayed.game.name} — ${stats.mostPlayed.hours} hours` : 'No playtime yet'}</p></div>
    </div>
  </BrowserWindow>;
}
