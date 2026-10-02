import type { Progression } from '@/lib/history/progression';

/** Personal progress only. The owning surface fetches /api/user/stats and supplies progression. */
export function StreakWidget({ progression }: { progression: Progression }) {
  const counters = [
    ['Current streak', `${progression.current} ${progression.current === 1 ? 'day' : 'days'}`],
    ['Longest streak', `${progression.longest} ${progression.longest === 1 ? 'day' : 'days'}`],
    ['Games discovered', progression.gamesDiscovered],
    ['Backlog games started', progression.backlogGamesStarted],
    ['Challenges completed', progression.challengesCompleted],
    ['Rare achievements completed', progression.rareAchievementsCompleted],
  ];
  return (
    <section aria-label="Your QIT progress" className="border-2 border-black bg-white p-4 text-black shadow-[4px_4px_0_0_#000]">
      <h2 className="text-xl font-bold">Your QIT progress</h2>
      <p className="mt-1 text-sm">Play a game you have never touched, play a Daily or Friend Night pick, or complete a challenge to count today. Explore the games you already own, at your pace.</p>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        {counters.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm">{label}</dt>
            <dd className="text-xl font-bold">{value}</dd>
          </div>
        ))}
      </dl>
      {progression.longest === 0 && <p className="mt-3 text-sm">Your next qualifying action starts your first streak.</p>}
    </section>
  );
}
