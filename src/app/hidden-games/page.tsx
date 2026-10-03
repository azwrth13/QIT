'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ExcludableResultCard } from '@/components/result-card/ExcludableResultCard';
import { SCOPE_LABELS, updateExclusion } from '@/components/result-card/exclusion-client';
import type { ExclusionScope } from '@/lib/store/types';
import type { Game } from '@/lib/games';

type Hide = { appid: number; scope: ExclusionScope; until: string | null; sessionId: string | null };
const button = 'border-4 border-black bg-neobrutal-yellow px-4 py-2 font-bold disabled:opacity-50';

export default function HiddenGamesPage() {
  const [hides, setHides] = useState<Hide[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [selected, setSelected] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch('/api/user/exclusions', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? 'Unable to load hidden games');
    setHides(data.exclusions);
  }, []);
  useEffect(() => {
    setSessionId(crypto.randomUUID());
    Promise.all([load(), fetch('/api/games').then(async response => {
      if (!response.ok) return;
      const data = await response.json();
      setGames(data.games ?? []);
    })]).catch(error => setMessage(error.message)).finally(() => setLoading(false));
  }, [load]);
  useEffect(() => {
    if (!sessionId) return;
    const end = () => { void fetch('/api/user/exclusions', {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'end-session', sessionId }),
    }).catch(() => {}); };
    window.addEventListener('pagehide', end);
    return () => window.removeEventListener('pagehide', end);
  }, [sessionId]);
  async function mutate(body: Parameters<typeof updateExclusion>[0]) {
    setBusy(true);
    setMessage('');
    try { await updateExclusion(body); await load(); return true; }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to update hidden games'); return false; }
    finally { setBusy(false); }
  }
  const game = games.find(item => String(item.appid) === selected);
  return <main className="mx-auto max-w-4xl p-6 text-black">
    <Link href="/library" className="underline font-bold">Back to library</Link>
    <h1 className="my-6 text-3xl font-bold">Hidden games</h1>
    <p className="mb-4">Choose a game and hide it for a while, or bring it back into your recommendation pool.</p>
    {message && <p role="status" className="my-4 font-bold">{message}</p>}
    {loading ? <p role="status">Loading hidden games...</p> : <>
      <label className="font-bold">Choose a game from your library
        <select value={selected} onChange={event => setSelected(event.target.value)} className="my-4 block w-full border-4 border-black p-2">
          <option value="">Select a game</option>
          {games.map(item => <option key={item.appid} value={item.appid}>{item.name}</option>)}
        </select>
      </label>
      {game && <ExcludableResultCard sessionId={sessionId} onExcluded={() => void load().catch(error => setMessage(error.message))} card={{
        appid: game.appid, name: game.name, modeId: 'pure-random', rollId: null,
        art: { header: null, icon: null }, reasons: [], playtimeForever: game.playtime_forever ?? 0,
        lastPlayedAt: null, achievements: null, live: null, friends: null, previousSelections: 0,
        storeUrl: 'https://store.steampowered.com/app/' + game.appid, launchUrl: 'steam://run/' + game.appid,
      }} />}
      <p className="my-4 text-sm">Session hides created here apply to this page session. Picker and lobby surfaces use their own session ids.</p>
      <button className={button} disabled={busy || !sessionId} onClick={() => {
        void mutate({ action: 'end-session', sessionId }).then(ok => { if (ok) setSessionId(crypto.randomUUID()); });
      }}>End this session</button>
      {Object.entries(SCOPE_LABELS).map(([scope, label]) => <section key={scope} className="my-6 border-4 border-black bg-white p-4">
        <h2 className="mb-3 text-xl font-bold">{label}</h2>
        {hides.filter(hide => hide.scope === scope).length === 0 && <p>No games hidden.</p>}
        <ul>{hides.filter(hide => hide.scope === scope).map(hide => <li key={hide.appid} className="mb-3 flex flex-wrap items-center gap-4">
          <span>{games.find(item => item.appid === hide.appid)?.name ?? 'Steam game ' + hide.appid}
            {hide.until && <span className="block text-sm">Until {new Date(hide.until).toLocaleString()}</span>}
            {hide.scope === 'session' && <span className="block text-sm">Session: {hide.sessionId}</span>}
          </span>
          <button disabled={busy} className={button} onClick={() => void mutate({ action: 'unhide', appid: hide.appid })}>Un-hide</button>
        </li>)}</ul>
      </section>)}
    </>}
  </main>;
}
