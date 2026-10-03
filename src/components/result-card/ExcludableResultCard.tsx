'use client';

import { useState } from 'react';
import { ResultCard, type ResultCardProps } from './ResultCard';
import { SCOPE_LABELS, updateExclusion } from './exclusion-client';
import type { ExclusionScope } from '@/lib/store/types';

/** Owning surfaces supply their picker/lobby session id and end it through the exclusions API. */
export function ExcludableResultCard({ sessionId, onExcluded, ...props }: Omit<ResultCardProps, 'onNotTonight' | 'onExclude'> & {
  sessionId?: string; onExcluded?: (appid: number) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function hide(scope: ExclusionScope) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await updateExclusion({ action: 'hide', appid: props.card.appid, scope, ...(scope === 'session' ? { sessionId } : {}) });
      setChoosing(false);
      setMessage('Game hidden. You can un-hide it in Hidden games.');
      onExcluded?.(props.card.appid);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to hide game'); }
    finally { setBusy(false); }
  }
  return <div>
    <ResultCard {...props} busyAction={busy ? 'exclude' : props.busyAction}
      onNotTonight={() => void hide('day')} onExclude={() => setChoosing(true)} />
    {choosing && <div className="mt-4 border-4 border-black bg-white p-4" aria-label="Choose hide duration">
      <p className="font-bold">How long should we hide this game?</p>
      {Object.entries(SCOPE_LABELS).map(([scope, label]) => <button key={scope} disabled={busy || (scope === 'session' && !sessionId)}
        className="m-2 border-2 border-black p-2 disabled:opacity-50" onClick={() => void hide(scope as ExclusionScope)}>{label}</button>)}
      <button disabled={busy} onClick={() => setChoosing(false)} className="m-2 underline">Cancel</button>
    </div>}
    {message && <p role="status" className="mt-2 font-bold">{message}</p>}
    <a href="/hidden-games" className="mt-2 inline-block underline font-bold">Manage hidden games</a>
  </div>;
}
