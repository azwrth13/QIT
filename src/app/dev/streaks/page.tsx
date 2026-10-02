import { notFound } from 'next/navigation';
import { StreakWidget } from '@/components/progression/StreakWidget';
import type { Progression } from '@/lib/history/progression';

const empty: Progression = { current: 0, longest: 0, lastDay: null, gamesDiscovered: 0, backlogGamesStarted: 0, challengesCompleted: 0, rareAchievementsCompleted: 0 };
const active: Progression = { current: 3, longest: 7, lastDay: '2026-10-01', gamesDiscovered: 12, backlogGamesStarted: 4, challengesCompleted: 6, rareAchievementsCompleted: 2 };

/** Local fixture gallery; no session or live Steam data required. */
export default function StreakFixtures() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <main className="mx-auto max-w-xl space-y-8 p-6">
    <h1 className="text-2xl font-bold">Streak widget fixtures</h1>
    <StreakWidget progression={empty} />
    <StreakWidget progression={active} />
    <StreakWidget progression={{ ...active, current: 0 }} />
  </main>;
}
