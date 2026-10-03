'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Dices, ExternalLink, Gamepad2, RefreshCw, Search, User } from 'lucide-react';
import { ExcludableResultCard } from '@/components/result-card/ExcludableResultCard';
import { formatPlaytime } from '@/components/result-card/format';
import type { CompareResult } from '@/lib/compare/types';
import type { GroupGame } from '@/lib/group/libraries';
import type { Card } from '@/lib/roulette/types';
import { isNavEnabled } from '@/app/navbar/nav-items';

type TabKey = 'both' | 'neitherRecentlyPlayed' | 'oneNeverPlayed' | 'onlyMe' | 'onlyThem';
type SortKey = 'name' | 'playtimeMe' | 'playtimeThem';

export default function CompareClient({
  steamid,
  currentUserSteamId,
  initialData,
}: {
  steamid: string;
  currentUserSteamId?: string;
  initialData?: CompareResult;
}) {
  const [data, setData] = useState<CompareResult | null>(initialData ?? null);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<{ message: string; code?: string; state?: string } | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('both');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [spinning, setSpinning] = useState(false);
  const [spinError, setSpinError] = useState('');
  const [rolledCard, setRolledCard] = useState<Card | null>(null);

  const loadComparison = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/compare/${encodeURIComponent(steamid)}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) {
        throw {
          message: result.error?.message ?? 'Could not compare libraries.',
          code: result.error?.code,
          state: result.error?.state,
        };
      }
      setData(result);
    } catch (err) {
      if (err && typeof err === 'object' && 'message' in err) {
        setError(err as { message: string; code?: string; state?: string });
      } else {
        setError({ message: 'Could not load library comparison. Please try again.' });
      }
    } finally {
      setLoading(false);
    }
  }, [steamid]);

  useEffect(() => {
    if (!initialData) void loadComparison();
  }, [loadComparison, initialData]);

  async function handleSpin() {
    if (spinning) return;
    setSpinning(true);
    setSpinError('');
    try {
      const response = await fetch('/api/roulette/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'everyone-owns-it',
          scope: { kind: 'pair', with: steamid },
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error?.message ?? 'Failed to spin shared games.');
      }
      if (result.card) {
        setRolledCard(result.card);
      } else {
        setSpinError('No eligible shared games found for this spin.');
      }
    } catch (err) {
      setSpinError(err instanceof Error ? err.message : 'Spin failed. Please try again.');
    } finally {
      setSpinning(false);
    }
  }

  if (loading) {
    return (
      <main className="container mx-auto px-4 py-8 text-black max-w-6xl">
        <div className="border-4 border-black bg-white p-8 shadow-neobrutal text-center">
          <p className="text-xl font-bold flex items-center justify-center gap-2">
            <RefreshCw className="h-6 w-6 motion-safe:animate-spin" />
            Comparing Steam libraries...
          </p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="container mx-auto px-4 py-8 text-black max-w-6xl">
        <div className="mb-4">
          <Link href="/library" className="underline font-bold">← Back to Library</Link>
          {isNavEnabled('friends') && (
            <Link href="/friends" className="ml-4 underline font-bold">Friends</Link>
          )}
        </div>
        <div className="border-4 border-black bg-neobrutal-pink p-8 shadow-neobrutal">
          <h1 className="text-2xl font-bold mb-2">Library Comparison Error</h1>
          <p className="font-bold text-lg mb-4">{error.message}</p>
          {error.state === 'private' && (
            <div className="border-2 border-black bg-white p-4 text-sm font-medium">
              <p className="font-bold mb-1">How your friend can make their library visible:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Open Steam profile and click <strong>Edit Profile</strong>.</li>
                <li>Go to <strong>Privacy Settings</strong> tab.</li>
                <li>Set <strong>My Profile</strong> and <strong>Game details</strong> to <strong>Public</strong>.</li>
              </ol>
            </div>
          )}
          <div className="mt-6 flex gap-4">
            <button
              onClick={() => void loadComparison()}
              className="border-4 border-black bg-white px-4 py-2 font-bold shadow-neobrutal hover:translate-x-0.5 hover:translate-y-0.5"
            >
              Try Again
            </button>
            <Link
              href="/compare"
              className="border-4 border-black bg-neobrutal-yellow px-4 py-2 font-bold shadow-neobrutal inline-block"
            >
              Compare with Someone Else
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (!data) return null;

  const targetName = data.target.personaName || 'Friend';
  const targetId = data.target.steamId;
  const userId = data.user.steamId || currentUserSteamId || '';

  const tabGames: Record<TabKey, GroupGame[]> = {
    both: data.both,
    neitherRecentlyPlayed: data.neitherRecentlyPlayed,
    oneNeverPlayed: data.oneNeverPlayed,
    onlyMe: data.onlyMe,
    onlyThem: data.onlyThem,
  };

  const currentGames = tabGames[activeTab] || [];
  const searchFiltered = currentGames.filter(g =>
    g.name.toLowerCase().includes(search.toLowerCase().trim())
  );

  const sortedGames = [...searchFiltered].sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'playtimeMe') {
      const pA = a.playtimeByPlayer[userId] ?? -1;
      const pB = b.playtimeByPlayer[userId] ?? -1;
      return pB - pA;
    }
    if (sortBy === 'playtimeThem') {
      const pA = a.playtimeByPlayer[targetId] ?? -1;
      const pB = b.playtimeByPlayer[targetId] ?? -1;
      return pB - pA;
    }
    return 0;
  });

  return (
    <main className="container mx-auto px-4 py-8 text-black max-w-6xl">
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <Link href="/library" className="underline font-bold">← Back to Library</Link>
        <Link href="/compare" className="underline font-bold">New comparison</Link>
        {isNavEnabled('friends') && <Link href="/friends" className="underline font-bold">Friends</Link>}
        {isNavEnabled('friend-night') && <Link href="/friend-night" className="underline font-bold">Friend Night</Link>}
      </div>

      {/* Header Profile Comparison */}
      <header className="border-4 border-black bg-white p-6 shadow-neobrutal mb-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="relative h-16 w-16 border-4 border-black bg-neobrutal-blue flex-none overflow-hidden">
              {data.user.avatarUrl ? (
                <Image src={data.user.avatarUrl} alt="Your avatar" fill sizes="64px" className="object-cover" unoptimized />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <User className="h-8 w-8" />
                </div>
              )}
            </div>
            <div>
              <span className="border-2 border-black bg-neobrutal-yellow px-2 py-0.5 text-xs font-bold uppercase">You</span>
              <h1 className="text-xl sm:text-2xl font-bold">{data.user.personaName || 'Your Library'}</h1>
              <p className="text-xs text-gray-700 font-mono">{userId}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 font-pixel text-lg font-bold bg-neobrutal-yellow border-2 border-black px-4 py-2">
            VS
          </div>

          <div className="flex items-center gap-4 text-right md:text-left">
            <div className="md:order-2 relative h-16 w-16 border-4 border-black bg-neobrutal-purple flex-none overflow-hidden">
              {data.target.avatarUrl ? (
                <Image src={data.target.avatarUrl} alt={`${targetName}'s avatar`} fill sizes="64px" className="object-cover" unoptimized />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <User className="h-8 w-8" />
                </div>
              )}
            </div>
            <div className="md:order-1">
              <span className="border-2 border-black bg-neobrutal-purple text-white px-2 py-0.5 text-xs font-bold uppercase">Friend</span>
              <h2 className="text-xl sm:text-2xl font-bold">
                <a href={data.target.profileUrl} target="_blank" rel="noopener noreferrer" className="hover:underline inline-flex items-center gap-1">
                  {targetName}
                  <ExternalLink className="h-4 w-4" />
                </a>
              </h2>
              <p className="text-xs text-gray-700 font-mono">{targetId}</p>
            </div>
          </div>
        </div>
      </header>

      {/* Stats Summary Cards */}
      <section aria-label="Library comparison statistics" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
        <button
          onClick={() => setActiveTab('both')}
          className={`border-4 border-black p-4 text-left shadow-neobrutal transition-transform ${
            activeTab === 'both' ? 'bg-neobrutal-green -translate-y-1' : 'bg-white hover:bg-gray-50'
          }`}
        >
          <dt className="text-xs font-bold uppercase tracking-wide">Shared Games</dt>
          <dd className="text-3xl font-bold mt-1">{data.sharedCount}</dd>
          <p className="text-xs mt-1 font-medium">Both players own</p>
        </button>

        <button
          onClick={() => setActiveTab('neitherRecentlyPlayed')}
          className={`border-4 border-black p-4 text-left shadow-neobrutal transition-transform ${
            activeTab === 'neitherRecentlyPlayed' ? 'bg-neobrutal-blue -translate-y-1' : 'bg-white hover:bg-gray-50'
          }`}
        >
          <dt className="text-xs font-bold uppercase tracking-wide">Neither Played Recently</dt>
          <dd className="text-3xl font-bold mt-1">{data.neitherRecentlyPlayed.length}</dd>
          <p className="text-xs mt-1 font-medium">Both inactive 90d+</p>
        </button>

        <button
          onClick={() => setActiveTab('oneNeverPlayed')}
          className={`border-4 border-black p-4 text-left shadow-neobrutal transition-transform ${
            activeTab === 'oneNeverPlayed' ? 'bg-neobrutal-yellow -translate-y-1' : 'bg-white hover:bg-gray-50'
          }`}
        >
          <dt className="text-xs font-bold uppercase tracking-wide">One Never Played</dt>
          <dd className="text-3xl font-bold mt-1">{data.oneNeverPlayed.length}</dd>
          <p className="text-xs mt-1 font-medium">0 mins for at least one</p>
        </button>

        <button
          onClick={() => setActiveTab('onlyMe')}
          className={`border-4 border-black p-4 text-left shadow-neobrutal transition-transform ${
            activeTab === 'onlyMe' ? 'bg-neobrutal-pink -translate-y-1' : 'bg-white hover:bg-gray-50'
          }`}
        >
          <dt className="text-xs font-bold uppercase tracking-wide">Only You Own</dt>
          <dd className="text-3xl font-bold mt-1">{data.onlyMe.length}</dd>
          <p className="text-xs mt-1 font-medium">Exclusive to your library</p>
        </button>

        <button
          onClick={() => setActiveTab('onlyThem')}
          className={`border-4 border-black p-4 text-left shadow-neobrutal transition-transform ${
            activeTab === 'onlyThem' ? 'bg-neobrutal-purple text-white -translate-y-1' : 'bg-white hover:bg-gray-50'
          }`}
        >
          <dt className="text-xs font-bold uppercase tracking-wide">Only {targetName} Owns</dt>
          <dd className="text-3xl font-bold mt-1">{data.onlyThem.length}</dd>
          <p className="text-xs mt-1 font-medium">Exclusive to their library</p>
        </button>
      </section>

      {/* Spin Shared Games Button */}
      <section aria-label="Shared games roulette" className="border-4 border-black bg-neobrutal-yellow p-6 shadow-neobrutal mb-8 text-center sm:text-left sm:flex sm:items-center sm:justify-between gap-6">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2 justify-center sm:justify-start">
            <Dices className="h-6 w-6" />
            Spin the Shared Games
          </h2>
          <p className="mt-1 font-medium">
            Launch a roulette using the {data.sharedCount} games both you and {targetName} own.
          </p>
          {spinError && <p role="alert" className="mt-2 text-sm font-bold text-red-700">{spinError}</p>}
        </div>

        <button
          onClick={() => void handleSpin()}
          disabled={spinning || data.sharedCount === 0}
          className="mt-4 sm:mt-0 flex-none border-4 border-black bg-neobrutal-green px-6 py-4 text-lg font-bold shadow-neobrutal hover:translate-x-0.5 hover:translate-y-0.5 disabled:opacity-50 inline-flex items-center gap-2"
        >
          <RefreshCw className={`h-5 w-5 ${spinning ? 'motion-safe:animate-spin' : ''}`} />
          {spinning ? 'Spinning shared games…' : 'Spin the shared games'}
        </button>
      </section>

      {/* Rolled Game Result Card */}
      {rolledCard && (
        <section aria-label="Roulette result" className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Gamepad2 className="h-5 w-5" />
              Roulette Recommendation
            </h2>
            <button
              onClick={() => setRolledCard(null)}
              className="text-sm font-bold underline hover:text-gray-700"
            >
              Dismiss pick
            </button>
          </div>
          <ExcludableResultCard
            card={rolledCard}
            onPlay={c => {
              window.location.href = c.launchUrl;
            }}
            onReroll={() => void handleSpin()}
            onViewOnSteam={c => {
              window.open(c.storeUrl, '_blank', 'noopener,noreferrer');
            }}
          />
        </section>
      )}

      {/* Tab Navigation and Filters */}
      <section aria-label="Game lists and comparisons" className="border-4 border-black bg-white p-6 shadow-neobrutal">
        <div className="flex flex-wrap gap-2 border-b-4 border-black pb-4 mb-6">
          <button
            onClick={() => setActiveTab('both')}
            className={`border-2 border-black px-4 py-2 font-bold text-sm ${
              activeTab === 'both' ? 'bg-neobrutal-green shadow-neobrutal-sm' : 'bg-white hover:bg-gray-100'
            }`}
          >
            Both Own ({data.both.length})
          </button>
          <button
            onClick={() => setActiveTab('neitherRecentlyPlayed')}
            className={`border-2 border-black px-4 py-2 font-bold text-sm ${
              activeTab === 'neitherRecentlyPlayed' ? 'bg-neobrutal-blue shadow-neobrutal-sm' : 'bg-white hover:bg-gray-100'
            }`}
          >
            Neither Played Recently ({data.neitherRecentlyPlayed.length})
          </button>
          <button
            onClick={() => setActiveTab('oneNeverPlayed')}
            className={`border-2 border-black px-4 py-2 font-bold text-sm ${
              activeTab === 'oneNeverPlayed' ? 'bg-neobrutal-yellow shadow-neobrutal-sm' : 'bg-white hover:bg-gray-100'
            }`}
          >
            One Never Played ({data.oneNeverPlayed.length})
          </button>
          <button
            onClick={() => setActiveTab('onlyMe')}
            className={`border-2 border-black px-4 py-2 font-bold text-sm ${
              activeTab === 'onlyMe' ? 'bg-neobrutal-pink shadow-neobrutal-sm' : 'bg-white hover:bg-gray-100'
            }`}
          >
            Only You ({data.onlyMe.length})
          </button>
          <button
            onClick={() => setActiveTab('onlyThem')}
            className={`border-2 border-black px-4 py-2 font-bold text-sm ${
              activeTab === 'onlyThem' ? 'bg-neobrutal-purple text-white shadow-neobrutal-sm' : 'bg-white hover:bg-gray-100'
            }`}
          >
            Only {targetName} ({data.onlyThem.length})
          </button>
        </div>

        {/* Search and Sort controls */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search games by title…"
              className="w-full border-2 border-black p-2 pl-9 font-medium"
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="sort-select" className="text-sm font-bold whitespace-nowrap">Sort by:</label>
            <select
              id="sort-select"
              value={sortBy}
              onChange={e => setSortBy(e.target.value as SortKey)}
              className="border-2 border-black p-2 font-medium bg-white"
            >
              <option value="name">Title (A-Z)</option>
              <option value="playtimeMe">Your playtime</option>
              <option value="playtimeThem">{targetName}&apos;s playtime</option>
            </select>
          </div>
        </div>

        {/* Game list */}
        {sortedGames.length === 0 ? (
          <div className="border-2 border-dashed border-black p-8 text-center bg-[#FFFEF7]">
            <p className="font-bold text-lg">No games found in this view.</p>
            {search && <p className="text-sm text-gray-700 mt-1">Try clearing your search query.</p>}
          </div>
        ) : (
          <div className="divide-y-2 divide-black border-2 border-black">
            {sortedGames.map(game => {
              const myMinutes = game.playtimeByPlayer[userId];
              const theirMinutes = game.playtimeByPlayer[targetId];
              const isBothOwn = game.owners.length === 2;

              return (
                <div key={game.appid} className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white hover:bg-yellow-50/50">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="relative h-10 w-10 border-2 border-black bg-neobrutal-blue flex-none overflow-hidden">
                      {game.iconHash ? (
                        <Image
                          src={`https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.iconHash}.jpg`}
                          alt=""
                          fill
                          sizes="40px"
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center">
                          <Gamepad2 className="h-5 w-5" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={`https://store.steampowered.com/app/${game.appid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-bold text-base sm:text-lg hover:underline inline-flex items-center gap-1"
                        >
                          {game.name}
                          <ExternalLink className="h-3.5 w-3.5 flex-none" />
                        </a>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {isBothOwn && (
                          <span className="border border-black bg-neobrutal-green/40 px-1.5 py-0.2 text-[0.65rem] font-bold">
                            Both own
                          </span>
                        )}
                        {game.neverPlayedBy.includes(userId) && (
                          <span className="border border-black bg-neobrutal-pink px-1.5 py-0.2 text-[0.65rem] font-bold">
                            You never played
                          </span>
                        )}
                        {game.neverPlayedBy.includes(targetId) && (
                          <span className="border border-black bg-neobrutal-yellow px-1.5 py-0.2 text-[0.65rem] font-bold">
                            {targetName} never played
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Individual Playtime display (Decision D10) */}
                  <div className="flex sm:flex-col items-end gap-2 sm:gap-1 text-xs sm:text-sm font-medium whitespace-nowrap self-stretch sm:self-auto justify-between sm:justify-center border-t-2 sm:border-t-0 pt-2 sm:pt-0 border-gray-200">
                    <span className="inline-flex items-center gap-1">
                      <strong className="font-bold">You:</strong>{' '}
                      {data.playtimeHidden.me
                        ? 'Hidden'
                        : myMinutes === null
                        ? 'Hidden'
                        : formatPlaytime(myMinutes)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <strong className="font-bold">{targetName}:</strong>{' '}
                      {data.playtimeHidden.them
                        ? 'Hidden'
                        : theirMinutes === null
                        ? 'Hidden'
                        : formatPlaytime(theirMinutes)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
