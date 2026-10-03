'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ProfileStats } from '@/lib/profile/stats';

export default function ProfileStatsView() {
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setStats(null);
    async function load() {
      try {
        const response = await fetch('/api/profile/stats', { cache: 'no-store', signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? 'Unable to load your QIT stats');
        if (!controller.signal.aborted) setStats(body);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load your QIT stats');
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt]);
  if (error) return <div role="alert" className="border-4 border-black bg-white p-4">
    <p>{error}</p>
    <button className="mt-3 border-2 border-black px-4 py-2" onClick={() => setAttempt(value => value + 1)}>Try again</button>
  </div>;
  if (!stats) return <p role="status">Loading your QIT stats…</p>;

  const cards = [
    { label: 'Games owned', value: stats.totalGames, detail: 'Games in your last synced library.' },
    { label: 'Never played', value: stats.neverPlayed, detail: 'Games with zero recorded minutes. Hidden or incomplete playtime is unknown.' },
    { label: 'Games discovered through QIT', value: stats.gamesDiscovered, detail: 'Distinct recommended games recorded as played.' },
    { label: 'Backlog games started', value: stats.backlogGamesStarted, detail: 'Distinct recommended games that had no playtime when picked.' },
    { label: 'Daily recommendations accepted', value: stats.dailiesAccepted, detail: 'Recorded Daily acceptances. Counts appear as you use Daily QIT.' },
    { label: 'Friend Nights completed', value: stats.friendNightsCompleted, detail: 'Friend Night picks recorded as played.' },
    { label: 'Challenges completed', value: stats.challengesCompleted, detail: 'Completed achievement challenges, including rare challenges.' },
    { label: 'Rare achievements completed', value: stats.rareAchievementsCompleted, detail: 'Rare achievement challenges verified as completed.' },
    { label: 'Recommended, then played', value: stats.recommendedThenPlayed, detail: 'The distinct played games counted as discoveries above; repeat picks count once.' },
  ];
  return <>
    {stats.totalGames === null && <p className="mb-4">Sync your library to see your library totals.</p>}
    {stats.totalGames === 0 && <p className="mb-4">Your synced library is empty. Add games on Steam and sync your library to get started.</p>}
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map(card => <div key={card.label} className="border-4 border-black bg-white p-4 shadow-[4px_4px_0_0_#000]">
        <dt className="font-bold">{card.label}</dt>
        <dd className="my-2 text-3xl font-bold">{card.value === null ? 'Unknown' : card.value.toLocaleString()}</dd>
        <dd className="text-sm">{card.detail}</dd>
      </div>)}
      <div className="border-4 border-black bg-neobrutal-yellow p-4 shadow-[4px_4px_0_0_#000]">
        <dt className="font-bold">Most-used roulette mode</dt>
        <dd className="my-2 text-xl font-bold">{stats.mostUsedMode?.label ?? 'No selections yet'}</dd>
        <dd className="text-sm">{stats.mostUsedMode ? `${stats.mostUsedMode.selections.toLocaleString()} picks in this mode.` : 'Pick a game through QIT to start your stats.'}</dd>
      </div>
    </dl>
    <p className="mt-6 text-sm">Stats reflect recorded QIT activity and your latest library sync. Played games include manual confirmations and playtime increases detected during sync.</p>
    <Link className="mt-4 inline-block border-2 border-black bg-white px-4 py-2 font-bold" href="/library">Explore and sync your library</Link>
  </>;
}
