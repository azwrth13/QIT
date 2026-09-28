'use client';

import { useEffect, useState } from 'react';
import type { Game } from '../../../lib/games';
import BrowserWindow from '../../components/BrowserWindow';
import GameList from '../components/GamesList';
import RandomGamePicker from '../components/RandomGamePicker';

type PublicLibrary = { state: 'public' | 'private' | 'unknown'; profile: { personaName: string } | null; games: Game[]; message: string | null };

export default function PublicLibraryPage({ params }: { params: Promise<{ steamid: string }> }) {
  const [library, setLibrary] = useState<PublicLibrary | null>(null);
  const [filtered, setFiltered] = useState<Game[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    params.then(({ steamid }) => fetch(`/api/games/public/${encodeURIComponent(steamid)}`))
      .then(async response => {
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        if (active) setLibrary(data);
      }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [params]);
  return <div className="container mx-auto px-4 py-8">
    <BrowserWindow title="PUBLIC STEAM LIBRARY" className="mb-8">
      <h1 className="text-2xl font-bold text-black">{library?.profile?.personaName ? `${library.profile.personaName}'s library` : 'Steam library'}</h1>
      <p className="text-black">Games are read live from Steam. Public Game details are required.</p>
    </BrowserWindow>
    {error && <p role="alert" className="font-bold text-black">{error}</p>}
    {!library && !error && <p className="text-black">Loading Steam library...</p>}
    {library?.message && <p className="text-black font-bold">{library.message}</p>}
    {library?.state === 'public' && library.games.length === 0 && <p className="text-black font-bold">This public library has no games.</p>}
    {library?.state === 'public' && library.games.length > 0 && <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2"><GameList publicView games={library.games} onFilteredGamesChange={setFiltered} /></div>
      <RandomGamePicker games={filtered} />
    </div>}
  </div>;
}
