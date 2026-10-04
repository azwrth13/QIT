'use client';

import { useEffect, useRef, useState } from 'react';
import { ExcludableResultCard } from '@/components/result-card/ExcludableResultCard';
import { updateExclusion } from '@/components/result-card/exclusion-client';
import type { Card, FilterSelection, GroupMemberSignals } from '@/lib/roulette/types';
import type { FriendsResult } from '@/lib/social/friends';
import type { Discovery, PlayerState } from '@/lib/friend-night/model';
import { IndividualPlaytime, PlayerProgress } from './PlayerProgress';

const button = 'border-4 border-black bg-neobrutal-yellow px-4 py-2 font-bold disabled:opacity-50';
const field = 'block w-full border-2 border-black p-2';
async function api(url: string, body?: unknown) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message ?? 'Request failed');
  return data;
}

export function FriendNight({ steamId }: { steamId: string }) {
  const [friends, setFriends] = useState<FriendsResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [players, setPlayers] = useState<PlayerState[]>([]);
  const [excluded, setExcluded] = useState<PlayerState[]>([]);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [flags, setFlags] = useState<string[]>([]);
  const [activity, setActivity] = useState('ignore');
  const [discovery, setDiscovery] = useState<Discovery>('any');
  const [hours, setHours] = useState('10');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [pool, setPool] = useState<number | null>(null);
  const [unknown, setUnknown] = useState(0);
  const [card, setCard] = useState<Card | null>(null);
  const [members, setMembers] = useState<GroupMemberSignals[]>([]);
  const [sessionId, setSessionId] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    const lifecycle = generation;
    api('/api/steam/friends').then(data => { if (active) setFriends(data); }).catch(e => { if (active) setMessage(e.message); });
    const id = crypto.randomUUID(); setSessionId(id);
    return () => { active = false; lifecycle.current++; void updateExclusion({ action: 'end-session', sessionId: id }).catch(() => {}); };
  }, []);
  function invalidate() { generation.current++; setCard(null); setMembers([]); setPool(null); setUnknown(0); setMessage(''); }
  function toggle(id: string) {
    const removed = players.find(p => p.steamId === id && p.state === 'private');
    setExcluded(current => removed ? [...current.filter(p => p.steamId !== id), removed] : current.filter(p => p.steamId !== id));
    invalidate(); setPlayers([]);
    setSelected(current => current.includes(id) ? current.filter(p => p !== id) : [...current, id].slice(0, 16));
  }
  function request(action: 'pool' | 'spin') {
    const filters: FilterSelection[] = flags.map(id => ({ id: id as FilterSelection['id'] }));
    if (activity === 'active') filters.push({ id: 'player-activity', params: { mode: 'active' } });
    if (min !== '' || max !== '') filters.push({ id: 'playtime', params: {
      ...(min !== '' ? { minMinutes: Math.round(Number(min) * 60) } : {}), ...(max !== '' ? { maxMinutes: Math.round(Number(max) * 60) } : {}),
    } });
    return { action, mode: activity === 'prefer' ? 'alive-and-kicking' : 'everyone-owns-it',
      scope: { kind: 'friends', with: selected }, filters, discovery, hours: Number(hours), sessionId };
  }
  async function preview() {
    const result = await api('/api/friend-night', request('pool'));
    if (result.unavailable.length) { setPool(null); setMessage('Some libraries are missing from the preview cache. Spin to check them again, or reload libraries.'); return; }
    setPool(result.eligible); setUnknown(result.preview.steps.reduce((n: number, step: { unknown: number }) => n + step.unknown, 0));
  }
  async function load() {
    const token = ++generation.current;
    setBusy(true); setMessage(''); setCard(null); setPool(null);
    setPlayers(selected.map(id => ({ steamId: id, name: friends?.friends.find(f => f.steamId === id)?.personaName ?? id, state: 'loading' })));
    try {
      const results = await Promise.all(selected.map(async id => {
        let result;
        try { result = await api('/api/friend-night', { action: 'library', steamId: id }); }
        catch { result = { steamId: id, state: 'error' }; }
        if (generation.current === token) setPlayers(current => current.map(p => p.steamId === id ? { ...p, ...result } : p));
        return result;
      }));
      if (generation.current === token && results.every(p => p.state === 'ok')) await preview();
    } catch (e) { if (generation.current === token) setMessage(e instanceof Error ? e.message : 'Unable to load shared games'); }
    finally { if (generation.current === token) setBusy(false); }
  }
  async function spin() {
    setBusy(true); setMessage(''); setCard(null);
    try {
      const result = await api('/api/friend-night', request('spin'));
      setPool(result.eligible); setMembers(result.members); setCard(result.card);
      if (result.unavailable.length) { setPlayers(current => current.map(p => ({ ...p, ...(result.unavailable.find((u: { steamId: string }) => u.steamId === p.steamId) ?? {}) }))); setMessage('A library is unavailable. Remove that player or retry.'); }
      else if (!result.card) setMessage('No shared games match. Try relaxing the filters.');
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Unable to spin'); }
    finally { setBusy(false); }
  }
  async function addPin() {
    setBusy(true); setMessage('');
    try { await api('/api/steam/friends/pinned', { player: pin }); setFriends(await api('/api/steam/friends')); setPin(''); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Unable to pin player'); }
    finally { setBusy(false); }
  }
  const ready = selected.length > 0 && players.length === selected.length && players.every(p => p.state === 'ok');
  const change = () => invalidate();
  return <main className="mx-auto max-w-5xl p-6 text-black">
    <h1 className="my-6 text-3xl font-bold">Friend Night</h1>
    <p>Pick friends, find games you all own, and discover something to play together. You are always included.</p>
    <p className="my-2 text-sm">Individual playtime is shown where Steam shares it. Other players’ libraries are cached for 30 minutes.</p>
    {message && <p role="alert" className="my-4 font-bold">{message}</p>}
    {!friends ? <div><p role="status">{message ? 'Steam friends could not be loaded.' : 'Loading Steam friends…'}</p>
      {message && <button className={button} disabled={busy} onClick={() => {
        setBusy(true); setMessage('');
        void api('/api/steam/friends').then(setFriends).catch(e => setMessage(e.message)).finally(() => setBusy(false));
      }}>Retry friends</button>}
    </div> : <section className="my-4 border-4 border-black bg-white p-4">
      <h2 className="text-xl font-bold">Choose up to 16 friends</h2>
      {friends.message && <p>{friends.message}</p>}
      {friends.friends.length === 0 && <p>No players available yet.</p>}
      <fieldset disabled={busy} className="my-3 grid gap-2 sm:grid-cols-2">{friends.friends.map(f => <label key={f.steamId}>
        <input type="checkbox" checked={selected.includes(f.steamId)} disabled={!selected.includes(f.steamId) && selected.length >= 16} onChange={() => toggle(f.steamId)} /> {f.personaName}
      </label>)}</fieldset>
      {friends.source === 'pinned' && <form onSubmit={e => { e.preventDefault(); void addPin(); }}>
        <label>Pin a player by Steam profile URL, ID, or vanity name<input className={field} value={pin} disabled={busy} onChange={e => setPin(e.target.value)} /></label>
        <button className={button} disabled={busy || !pin.trim()}>Pin player</button>
      </form>}
    </section>}
    <PlayerProgress players={players} onRemove={busy ? undefined : toggle} />
    {excluded.length > 0 && <p role="status">Excluded from this group because their library is private: {excluded.map(p => p.name).join(', ')}.</p>}
    <fieldset disabled={busy} className="my-4 grid gap-4 border-4 border-black bg-white p-4 sm:grid-cols-2">
      <legend className="font-bold">Group filters</legend>
      {['multiplayer', 'co-op', 'not-recently-played', 'achievements'].map(id => <label key={id}><input type="checkbox" checked={flags.includes(id)} onChange={() => { change(); setFlags(current => current.includes(id) ? current.filter(f => f !== id) : [...current, id]); }} /> {({ multiplayer: 'Multiplayer', 'co-op': 'Co-op', 'not-recently-played': 'You have not played recently (90 days)', achievements: 'Achievement support' })[id]}</label>)}
      <label>Current player activity<select className={field} value={activity} onChange={e => { change(); setActivity(e.target.value); }}>
        <option value="ignore">Ignore count when choosing</option><option value="active">Only active games (100+ players)</option><option value="prefer">Prefer more active multiplayer games</option>
      </select></label>
      <label>Never played together<select className={field} value={discovery} onChange={e => { change(); setDiscovery(e.target.value as Discovery); }}>
        <option value="any">Any shared game</option><option value="nobody">Nobody has played it</option><option value="one-new">At least one player has never played it</option><option value="under-hours">Everyone has less than X hours</option><option value="veteran">One experienced player + new players</option><option value="everyone-played">Played by everyone</option>
      </select></label>
      {(discovery === 'under-hours' || discovery === 'veteran') && <label>{discovery === 'veteran' ? 'Experienced player minimum hours' : 'Everyone below hours'}<input className={field} type="number" min="0.01" step="0.01" value={hours} onChange={e => { change(); setHours(e.target.value); }} /></label>}
      <label>Your minimum hours<input className={field} type="number" min="0" step="0.1" value={min} onChange={e => { change(); setMin(e.target.value); }} /></label>
      <label>Your maximum hours<input className={field} type="number" min="0" step="0.1" value={max} onChange={e => { change(); setMax(e.target.value); }} /></label>
    </fieldset>
    <div className="flex flex-wrap gap-4"><button className={button} disabled={busy || selected.length === 0} onClick={() => void load()}>Load libraries and check shared games</button>
      <button className={button} disabled={busy || !ready || !sessionId} onClick={() => void spin()}>Spin Friend Night</button>
    </div>
    <p role="status" className="my-4">{busy ? 'Working…' : pool === null ? 'Check shared games after selecting friends or changing filters.' : `${pool} shared games match.`}</p>
    {unknown > 0 && <p>{unknown} filter checks could not be completed. Unknown games are excluded by the selected filters; spinning can refresh bounded metadata and activity data.</p>}
    <p className="text-sm">The preview uses cached data. Spin to refresh missing metadata and player counts. Activity bands compare known counts in this pool (top/bottom quarter); high activity requires at least 100 players. Missing counters have no badge.</p>
    {card && <section className="my-6">
      <ExcludableResultCard card={card} sessionId={sessionId} onViewOnSteam={() => {}} onReroll={() => void spin()} busyAction={busy ? 'reroll' : null} onExcluded={() => { setCard(null); void load(); }} />
      <IndividualPlaytime members={members} steamId={steamId} names={Object.fromEntries((friends?.friends ?? []).map(f => [f.steamId, f.personaName]))} />
    </section>}
  </main>;
}
