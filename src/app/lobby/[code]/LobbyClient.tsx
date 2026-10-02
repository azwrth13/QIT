'use client';

import { useEffect, useRef, useState } from 'react';
import type { LobbyView } from '@/lib/lobby/model';

export default function LobbyClient({ code, steamId }: { code: string; steamId: string }) {
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [pollError, setPollError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const version = useRef<number | undefined>(undefined);
  const endpoint = `/api/lobby/${code}`;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let running = false;
    const schedule = () => { timer = setTimeout(poll, document.hidden ? 8000 : 2000); };
    async function poll() {
      if (stopped || running) return;
      clearTimeout(timer);
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch(`${endpoint}${version.current === undefined ? '' : `?since=${version.current}`}`, { cache: 'no-store', signal: controller.signal });
        if (response.status !== 304) {
          const result = await response.json();
          if (!response.ok) throw new Error(result.error?.message ?? 'Could not load lobby.');
          if (!stopped && (version.current === undefined || result.lobby.version >= version.current)) {
            version.current = result.lobby.version; setLobby(result.lobby);
          }
        }
        if (!stopped) setPollError('');
      } catch (cause) { if (!stopped) setPollError(cause instanceof Error ? cause.message : 'Could not load lobby.'); }
      finally { running = false; if (!stopped) schedule(); }
    }
    const visibility = () => { clearTimeout(timer); if (!running) { if (document.hidden) schedule(); else void poll(); } };
    void poll();
    document.addEventListener('visibilitychange', visibility);
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [endpoint]);

  async function mutate(method: 'POST' | 'DELETE' | 'PATCH', body?: unknown) {
    setBusy(true); setActionError('');
    try {
      const response = await fetch(`${endpoint}${method === 'POST' ? '/join' : ''}`, {
        method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not update lobby.');
      if (version.current === undefined || result.lobby.version >= version.current) {
        version.current = result.lobby.version; setLobby(result.lobby);
      }
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not update lobby.'); }
    finally { setBusy(false); }
  }

  const member = lobby?.members.find(m => m.steamId === steamId);
  const active = lobby?.status === 'active';
  const button = 'border-4 border-black bg-neobrutal-blue px-4 py-2 disabled:opacity-50';
  return <main className="container mx-auto p-8 text-black">
    <h1 className="text-3xl font-bold">Game Night Lobby {code}</h1>
    <p className="my-4">Share this page’s link with your friends. Up to eight players can join.</p>
    {pollError && <p role="alert" className="my-4">{pollError}</p>}
    {actionError && <p role="alert" className="my-4">{actionError}</p>}
    {!lobby && !pollError && <p>Loading lobby…</p>}
    {lobby && <>
      {!active && <p>This lobby has ended.</p>}
      <p className="my-4">{lobby.commonCount} games in common · {lobby.filteredCount} match shared filters</p>
      {lobby.filterUnknownCount > 0 && <p>{lobby.filterUnknownCount} games lack data required by a shared filter.</p>}
      <ul className="my-4 space-y-2">{lobby.members.map(m => <li key={m.steamId} className="border-2 border-black p-3">
        {m.name}{m.steamId === lobby.hostId ? ' (host)' : ''} — {m.state}
        {m.libraryState !== 'ok' && <span> · Library {m.libraryState === 'private' ? 'private' : 'unavailable'}; excluded from common games</span>}
      </li>)}</ul>
      {active && <div className="flex flex-wrap gap-3">
        {!member ? <button className={button} disabled={busy} onClick={() => void mutate('POST')}>Join lobby</button> : <>
          <button className={button} disabled={busy} onClick={() => void mutate('PATCH', { state: member.state === 'ready' ? 'present' : 'ready' })}>{member.state === 'ready' ? 'Set present' : 'Ready'}</button>
          <button className={button} disabled={busy} onClick={() => void mutate('PATCH', { state: 'away' })}>Set away</button>
          <button className={button} disabled={busy} onClick={() => void mutate('DELETE')}>Leave lobby</button>
        </>}
      </div>}
      {active && member && lobby.hostId === steamId && <label className="my-6 block">
        <input type="checkbox" className="mr-2" disabled={busy} checked={lobby.filters.some(f => f.id === 'never-played')}
          onChange={event => void mutate('PATCH', { filters: event.target.checked ? [...lobby.filters.filter(f => f.id !== 'never-played'), { id: 'never-played' }] : lobby.filters.filter(f => f.id !== 'never-played') })} />
        Only games the host has never played
      </label>}
    </>}
  </main>;
}
