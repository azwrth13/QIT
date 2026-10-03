'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { FriendsResult } from '@/lib/social/friends';
import { parseWithParam } from '@/lib/links/with-param';
import BrowserWindow from '../components/BrowserWindow';
import FriendCard from './FriendCard';
import { PAGE_SIZE, requestJson } from './dashboard-client';

export default function FriendsPage() {
  const [result, setResult] = useState<FriendsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [player, setPlayer] = useState('');
  const [pinning, setPinning] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/steam/friends', { cache: 'no-store' });
      if (response.status === 401) { setUnauthorized(true); return; }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not load friends.');
      setUnauthorized(false); setResult(data);
    } catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); setSelected(parseWithParam(new URLSearchParams(window.location.search).getAll('with'))); }, []);
  async function pin(event: React.FormEvent) {
    event.preventDefault(); setPinning(true); setError('');
    try { await requestJson('/api/steam/friends/pinned', { player }); setPlayer(''); await load(); }
    catch (error) { setError((error as Error).message); }
    finally { setPinning(false); }
  }
  async function unpin(id: string) {
    setError('');
    try { await requestJson(`/api/steam/friends/pinned?steamid=${id}`, undefined, 'DELETE'); await load(); }
    catch (error) { setError((error as Error).message); }
  }
  const filtered = (result?.friends ?? []).filter(friend => `${friend.personaName} ${friend.steamId}`.toLowerCase().includes(search.toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const fallback = result?.source === 'pinned' || result?.message?.includes('private');
  return <div className="container mx-auto px-4 py-8 text-black">
    <BrowserWindow title="PLAY WITH FRIENDS" className="mb-8">
      <h1 className="text-3xl font-bold mb-3">Steam friend dashboard</h1>
      <p>Discover games you can play together. Shared counts load as cards come into view; expand a card for recent games.</p>
      <p className="mt-2 text-sm">Public Steam games and playtime may be cached for up to 30 minutes. Private game details remain inaccessible.</p>
      <Link href="/library" className="underline">Sync your library</Link>
    </BrowserWindow>
    {loading && <p role="status">Loading players…</p>}
    {error && <div role="alert" className="mb-4"><p>{error}</p><button className="border-2 border-black p-2" onClick={load}>Retry loading friends</button></div>}
    {unauthorized && <a href="/api/auth/steam-login" className="font-bold underline">Sign in with Steam to discover games with friends</a>}
    {!unauthorized && result && <>
      {result.message && <p className="mb-4">{result.message}</p>}
      {fallback && <form onSubmit={pin} className="border-4 border-black bg-neobrutal-yellow p-4 mb-6">
        <h2 className="text-xl font-bold">Pin players instead</h2>
        <p>Use a public Steam profile URL, a 17-digit Steam ID, or a vanity name. Pinning cannot reveal private games.</p>
        <label className="block mt-3" htmlFor="pin-player">Steam player</label>
        <div className="flex flex-wrap gap-2"><input id="pin-player" required maxLength={200} value={player} onChange={event => setPlayer(event.target.value)} className="border-2 border-black p-2 min-w-0 flex-1" />
          <button disabled={pinning} className="border-2 border-black p-2 font-bold disabled:opacity-50">{pinning ? 'Pinning…' : 'Pin player'}</button></div>
      </form>}
      <label htmlFor="friend-search" className="font-bold">Find a player</label>
      <input id="friend-search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} className="block border-2 border-black p-2 w-full mb-6" />
      {!filtered.length && <p>No players found. {fallback ? 'Pin a player above to get started.' : 'Try a different search.'}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">{filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(friend =>
        <FriendCard key={friend.steamId} friend={friend} pinned={result.source === 'pinned'} selected={selected} onUnpin={unpin} />)}</div>
      {filtered.length > PAGE_SIZE && <nav aria-label="Friend pages" className="flex justify-center gap-4 my-6">
        <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="border-2 border-black px-3 py-2 disabled:opacity-50">Previous</button>
        <span className="self-center">Page {currentPage + 1} of {Math.ceil(filtered.length / PAGE_SIZE)}</span>
        <button disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(currentPage + 1)} className="border-2 border-black px-3 py-2 disabled:opacity-50">Next</button>
      </nav>}
    </>}
  </div>;
}
