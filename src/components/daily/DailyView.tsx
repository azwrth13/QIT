'use client';

import Link from 'next/link';
import { ExcludableResultCard } from '@/components/result-card/ExcludableResultCard';
import { ResultCard } from '@/components/result-card/ResultCard';
import { canAct, DAILY_REROLL_LIMIT, type DailyAction, type DailyView as DailyRecord } from '@/lib/daily/model';

export const DAILY_BUTTON = 'border-2 border-black bg-neobrutal-yellow px-4 py-2 font-bold shadow-neobrutal-sm disabled:opacity-50';
const LABELS: Record<DailyRecord['status'], string> = {
  ready: 'Ready to discover', accepted: 'Accepted — play it when you’re ready', played: 'Played — today counts toward your streak',
  skipped: 'Skipped — this pick earns no streak credit', empty: 'No games match today’s selection rules',
};

/** Shared fixture-friendly view for current and historical snapshots, including absent enrichment and empty pools. */
export function DailyView({ daily, busy = false, onAction, historical = false }: {
  daily: DailyRecord; busy?: boolean; onAction?: (action: DailyAction) => void; historical?: boolean;
}) {
  const terminal = historical || daily.status === 'skipped' || daily.status === 'played';
  return <section aria-label={`Daily QIT for ${daily.date}`} className="space-y-4">
    <div className="border-4 border-black bg-neobrutal-blue p-4 shadow-neobrutal">
      <h2 className="text-xl font-bold">{daily.date}</h2>
      <p>{daily.tz}</p><p role="status" className="font-bold">{historical && daily.status === 'played' ? 'Played — this day earned streak credit' : LABELS[daily.status]}</p>
      <p>{DAILY_REROLL_LIMIT - daily.rerolls} rerolls remaining</p>
    </div>
    {daily.selection.card ? terminal ? <ResultCard card={daily.selection.card} now={Math.floor(daily.selection.selectedAt / 1000)} onViewOnSteam={() => {}} />
      : <ExcludableResultCard key={`${daily.date}:${daily.rerolls}`} card={daily.selection.card} now={Math.floor(daily.selection.selectedAt / 1000)}
        onViewOnSteam={() => {}} busyAction={busy ? 'reroll' : null} />
      : <div className="border-4 border-black bg-white p-6"><p>No eligible game is available. Your library may be empty, hidden, recently recommended, or missing data for this mode.</p>
        {!historical && <Link href="/library" className="mt-2 inline-block font-bold underline">Review and sync your library</Link>}
        {!historical && <p className="mt-2">You can reroll within today’s limit. Default settings apply tomorrow.</p>}</div>}
    {Object.entries(daily.selection.coverage).some(([, value]) => value !== undefined && value < 1) && <p className="text-sm">Some game data is unavailable. Reasons only use the data QIT knows.</p>}
    {!terminal && onAction && <div className="flex flex-wrap gap-3">
      {canAct(daily, 'accept') && <button className={DAILY_BUTTON} disabled={busy} onClick={() => onAction('accept')}>Accept daily game</button>}
      {canAct(daily, 'played') && <button className={DAILY_BUTTON} disabled={busy} onClick={() => onAction('played')}>I played it</button>}
      {canAct(daily, 'reroll') && <button className={DAILY_BUTTON} disabled={busy} onClick={() => onAction('reroll')}>Reroll ({DAILY_REROLL_LIMIT - daily.rerolls} left)</button>}
      {canAct(daily, 'skip') && <button className={DAILY_BUTTON} disabled={busy} onClick={() => onAction('skip')}>Skip today</button>}
      {daily.selection.card && <a href={busy ? undefined : daily.selection.card.launchUrl} aria-disabled={busy || undefined} className={DAILY_BUTTON}>Launch in Steam</a>}
    </div>}
    {!historical && <p className="text-sm">Accepting saves your choice. Mark it played to earn today’s streak credit. Skipping ends today’s pick. Hiding a game affects future picks; today’s saved selection stays the same.</p>}
    {daily.previous.length > 0 && <details className="border-2 border-black bg-white p-4">
      <summary className="cursor-pointer font-bold">Earlier picks today ({daily.previous.length})</summary>
      <ul className="mt-3 space-y-2">{daily.previous.map((selection, index) => <li key={index}><details>
        <summary className="cursor-pointer">{selection.card?.name ?? 'No eligible game'} · {index === 0 ? 'First pick' : `Reroll ${index}`}</summary>
        {selection.card && <div className="mt-3"><ResultCard card={selection.card} now={Math.floor(selection.selectedAt / 1000)} onViewOnSteam={() => {}} /></div>}
      </details></li>)}</ul>
    </details>}
  </section>;
}
