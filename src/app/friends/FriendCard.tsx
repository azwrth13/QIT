'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { FriendProfile } from '@/lib/social/friends';
import type { SharedDetails, RecentDetails } from '@/lib/social/dashboard-types';
import type { Card } from '@/lib/roulette/types';
import { isNavEnabled } from '../navbar/nav-items';
import { details, findShared, friendNightHref, observeCard, spinWith } from './dashboard-client';

const statusNames = ['Offline', 'Online', 'Busy', 'Away', 'Snooze', 'Looking to trade', 'Looking to play'];
const buttonClass = 'border-2 border-black bg-neobrutal-blue px-3 py-2 font-bold disabled:opacity-50';

export default function FriendCard({ friend, pinned, selected = [], onUnpin }: {
  friend: FriendProfile; pinned: boolean; selected?: string[]; onUnpin?: (id: string) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const requested = useRef(false);
  const [shared, setShared] = useState<SharedDetails | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [recent, setRecent] = useState<RecentDetails | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [recentLoading, setRecentLoading] = useState(false);
  const [games, setGames] = useState<SharedDetails | null>(null);
  const [eligible, setEligible] = useState<number | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const loadCount = useCallback(() => {
    if (requested.current) return;
    requested.current = true;
    setCountLoading(true);
    details<SharedDetails>(friend.steamId, 'shared').then(result => {
      setShared(result);
      if (result.state === 'error') requested.current = false;
    }).catch(error => {
      requested.current = false;
      setShared({ state: 'error', message: error.message });
    }).finally(() => setCountLoading(false));
  }, [friend.steamId]);
  useEffect(() => root.current ? observeCard(root.current, loadCount) : undefined, [loadCount]);

  async function toggleRecent() {
    setExpanded(!expanded);
    if (expanded || recent || recentLoading) return;
    setRecentLoading(true);
    setError('');
    try { setRecent(await details<RecentDetails>(friend.steamId, 'recent')); }
    catch (error) { setError((error as Error).message); }
    finally { setRecentLoading(false); }
  }
  async function run(action: 'find' | 'spin') {
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'find') {
        const result = await findShared(friend.steamId);
        setShared(result.shared); setGames(result.shared); setEligible(result.eligible);
      } else {
        const result = await spinWith(friend.steamId);
        setCard(result.card);
        if (!result.card) setMessage('No shared games match roulette right now. Check Steam game privacy and sync your library.');
      }
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  const privateGames = shared?.state === 'private';
  return <article ref={root} className="border-4 border-black shadow-neobrutal bg-white p-4 text-black">
    <div className="flex gap-3 items-center">
      {friend.avatarFull && <Image src={friend.avatarFull} alt="" width={64} height={64} unoptimized className="border-2 border-black" />}
      <div><h2 className="text-xl font-bold break-words">{friend.personaName || friend.steamId}</h2>
        <p>{friend.status === undefined ? 'Status unavailable' : statusNames[friend.status] ?? 'Status unavailable'}</p>
        {friend.currentGame && <p>Playing {friend.currentGame.name}</p>}
        {pinned && <span className="text-sm font-bold">Pinned player</span>}
      </div>
    </div>
    <div className="my-4" aria-live="polite">
      {countLoading ? <p>Loading shared count…</p> : shared?.state === 'ok' ? <p className="font-bold">{shared.count} games shared</p> : shared ? <p>{shared.message}</p> : <p>Shared count loads when this card is visible.</p>}
      {!countLoading && (!shared || shared.state === 'error') && <button className={buttonClass} onClick={loadCount}>Load shared count</button>}
    </div>
    <div className="flex flex-wrap gap-2">
      {isNavEnabled('compare') && <Link className={buttonClass} href={`/compare/${friend.steamId}`}>Compare libraries</Link>}
      <button className={buttonClass} disabled={busy || privateGames} onClick={() => run('find')}>Find games we both own</button>
      {isNavEnabled('friend-night') && <Link className={buttonClass} href={friendNightHref(selected, friend.steamId)}>Add to Friend Night</Link>}
      <button className={buttonClass} disabled={busy || privateGames} onClick={() => run('spin')}>Start a roulette with this friend</button>
      {pinned && onUnpin && <button className={buttonClass} disabled={busy} onClick={() => onUnpin(friend.steamId)}>Unpin</button>}
    </div>
    {busy && <p role="status" className="mt-3">Finding games…</p>}
    {error && <p role="alert" className="mt-3">{error}</p>}
    {message && <p role="status" className="mt-3">{message}</p>}
    {games?.state === 'ok' && <div className="mt-4"><h3 className="font-bold">Games you both own ({games.count})</h3>
      <p>{eligible} currently match roulette after exclusions and game filters.</p>
      <ul className="max-h-64 overflow-auto list-disc pl-5">{games.games?.map(game => <li key={game.appid}>
        <a href={`https://store.steampowered.com/app/${game.appid}/`} target="_blank" rel="noopener noreferrer" className="underline">{game.name}</a>
        {game.friendMinutes !== null && ` — ${Math.round(game.friendMinutes / 60 * 10) / 10} hours played by ${friend.personaName}`}
      </li>)}</ul>{games.count === 0 && <p>You do not share any accessible games.</p>}
    </div>}
    {card && <div className="mt-4 border-2 border-black bg-neobrutal-green p-3" aria-live="polite">
      <h3 className="font-bold text-lg">Play {card.name} together</h3>
      <a href={card.launchUrl} className="underline mr-4">Launch game</a>
      <a href={card.storeUrl} target="_blank" rel="noopener noreferrer" className="underline">View on Steam</a>
    </div>}
    <button className={`${buttonClass} mt-4`} aria-expanded={expanded} aria-controls={`recent-${friend.steamId}`} onClick={toggleRecent}>Recently played</button>
    {expanded && <div id={`recent-${friend.steamId}`} className="mt-3">
      {recentLoading && <p role="status">Loading recent games…</p>}
      {recent?.state === 'private' && <p>{recent.message}</p>}
      {recent?.state === 'ok' && (recent.games.length ? <ul>{recent.games.map(game => <li key={game.appid}>
        <a className="underline" href={`https://store.steampowered.com/app/${game.appid}/`} target="_blank" rel="noopener noreferrer">{game.name}</a>
        {` — ${Math.round(game.playtime_2weeks / 60 * 10) / 10} hours in the last two weeks`}
      </li>)}</ul> : <p>No recently played games shared by Steam.</p>)}
    </div>}
  </article>;
}
