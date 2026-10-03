'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowRight, Search, User, Users } from 'lucide-react';
import { isSteamId } from '@/lib/steam';
import type { FriendProfile, FriendsResult } from '@/lib/social/friends';
import { isNavEnabled } from '@/app/navbar/nav-items';

export default function ComparePickerClient({ currentSteamId }: { currentSteamId: string }) {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [friends, setFriends] = useState<FriendProfile[]>([]);
  const [friendsMessage, setFriendsMessage] = useState<string | null>(null);
  const [loadingFriends, setLoadingFriends] = useState(true);
  const [friendSearch, setFriendSearch] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/steam/friends')
      .then(async res => {
        if (!res.ok) return null;
        return (await res.json()) as FriendsResult;
      })
      .then(data => {
        if (!active || !data) return;
        setFriends(data.friends ?? []);
        if (data.message) setFriendsMessage(data.message);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingFriends(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    const query = input.trim();
    if (!query) return;

    setSearchError('');
    if (isSteamId(query)) {
      if (query === currentSteamId) {
        setSearchError('You cannot compare your library with yourself.');
        return;
      }
      router.push(`/compare/${encodeURIComponent(query)}`);
      return;
    }

    setResolving(true);
    try {
      const response = await fetch(`/api/steam/search?q=${encodeURIComponent(query)}`);
      const result = await response.json();
      if (!response.ok || !result.steamId) {
        throw new Error(result.error ?? 'Could not find Steam profile');
      }
      if (result.steamId === currentSteamId) {
        throw new Error('You cannot compare your library with yourself.');
      }
      router.push(`/compare/${encodeURIComponent(result.steamId)}`);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Profile lookup failed.');
    } finally {
      setResolving(false);
    }
  }

  const filteredFriends = friends.filter(
    f =>
      f.steamId !== currentSteamId &&
      f.personaName.toLowerCase().includes(friendSearch.toLowerCase().trim())
  );

  return (
    <main className="container mx-auto px-4 py-8 text-black max-w-4xl">
      <div className="mb-4 flex items-center gap-4">
        <Link href="/library" className="underline font-bold">← Back to Library</Link>
        {isNavEnabled('friends') && <Link href="/friends" className="underline font-bold">Friends</Link>}
      </div>

      <header className="border-4 border-black bg-white p-6 shadow-neobrutal mb-8">
        <span className="border-2 border-black bg-neobrutal-yellow px-2 py-0.5 text-xs font-bold uppercase">
          Feature 11
        </span>
        <h1 className="text-3xl font-bold my-2">Compare Steam Libraries</h1>
        <p className="text-base font-medium">
          Compare your game library with a friend or any public Steam profile. See shared games, games only one of you owns, and games neither has played recently.
        </p>
      </header>

      {/* Manual lookup input */}
      <section aria-label="Find a player to compare" className="border-4 border-black bg-white p-6 shadow-neobrutal mb-8">
        <h2 className="text-xl font-bold mb-3">Compare by Profile URL or Steam ID</h2>
        <form onSubmit={handleLookup} className="space-y-4">
          <div>
            <label htmlFor="compare-input" className="block text-sm font-bold mb-1">
              Steam ID (17 digits), profile URL, or custom vanity URL:
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id="compare-input"
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="e.g. 76561198000000001, steamcommunity.com/id/gabelogannewell"
                className="flex-1 border-2 border-black p-3 font-medium"
              />
              <button
                type="submit"
                disabled={resolving || !input.trim()}
                className="border-4 border-black bg-neobrutal-green px-6 py-3 font-bold shadow-neobrutal hover:translate-x-0.5 hover:translate-y-0.5 disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                {resolving ? 'Looking up…' : 'Compare'}
                <ArrowRight className="h-5 w-5" />
              </button>
            </div>
          </div>
          {searchError && <p role="alert" className="text-sm font-bold text-red-700">{searchError}</p>}
        </form>
      </section>

      {/* Friends list */}
      <section aria-label="Compare with friends" className="border-4 border-black bg-white p-6 shadow-neobrutal">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Users className="h-5 w-5" />
              Your Friends
            </h2>
            <p className="text-sm font-medium text-gray-700">Select a friend to compare libraries immediately.</p>
          </div>
          {friends.length > 5 && (
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
              <input
                type="text"
                value={friendSearch}
                onChange={e => setFriendSearch(e.target.value)}
                placeholder="Filter friends…"
                className="w-full border-2 border-black p-2 pl-9 text-sm font-medium"
              />
            </div>
          )}
        </div>

        {friendsMessage && (
          <p className="text-sm font-bold bg-neobrutal-yellow/40 border border-black p-3 mb-4">
            {friendsMessage}
          </p>
        )}

        {loadingFriends ? (
          <p className="font-bold py-6 text-center">Loading Steam friends…</p>
        ) : filteredFriends.length === 0 ? (
          <div className="border-2 border-dashed border-black p-8 text-center bg-[#FFFEF7]">
            <p className="font-bold">No friends found.</p>
            <p className="text-sm text-gray-700 mt-1">You can still compare with anyone by pasting their profile URL above.</p>
          </div>
        ) : (
          <div className="divide-y-2 divide-black border-2 border-black max-h-96 overflow-y-auto">
            {filteredFriends.map(friend => (
              <div
                key={friend.steamId}
                className="p-4 flex items-center justify-between gap-4 hover:bg-yellow-50/50 bg-white"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative h-10 w-10 border-2 border-black bg-neobrutal-blue flex-none overflow-hidden">
                    {friend.avatarMedium ? (
                      <Image
                        src={friend.avatarMedium}
                        alt=""
                        fill
                        sizes="40px"
                        className="object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <User className="h-5 w-5" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold truncate">{friend.personaName}</p>
                    <p className="text-xs text-gray-600 font-mono truncate">{friend.steamId}</p>
                  </div>
                </div>

                <Link
                  href={`/compare/${encodeURIComponent(friend.steamId)}`}
                  className="border-2 border-black bg-neobrutal-yellow px-4 py-1.5 font-bold text-sm shadow-neobrutal-sm hover:translate-x-0.5 hover:translate-y-0.5 whitespace-nowrap"
                >
                  Compare
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
