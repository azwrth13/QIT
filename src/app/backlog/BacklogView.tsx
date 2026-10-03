'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { AlertCircle, Clock, ExternalLink, Gamepad2, Play, RefreshCw, Search, Trophy } from 'lucide-react';
import { ExcludableResultCard } from '@/components/result-card/ExcludableResultCard';
import { formatLastPlayed, formatPlaytime } from '@/components/result-card/format';
import type { Card } from '@/lib/roulette/types';
import {
  BACKLOG_CATEGORY_IDS,
  type BacklogCategory,
  type BacklogGameItem,
  type BacklogOverview,
} from '@/lib/backlog/types';

const buttonStyle =
  'border-4 border-black bg-neobrutal-yellow px-4 py-2 font-bold shadow-neobrutal transition-transform hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none disabled:opacity-50 disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-neobrutal';

export async function fetchBacklogOverview(signal?: AbortSignal): Promise<BacklogOverview> {
  const res = await fetch('/api/backlog', { cache: 'no-store', signal });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error(data?.error?.message ?? 'Unable to load backlog data');
  }
  return data;
}

export default function BacklogView({
  initialOverview = null,
  initialLoading = !initialOverview,
  initialError = null,
  initialCard = null,
  initialCategory = 'never-played',
}: {
  initialOverview?: BacklogOverview | null;
  initialLoading?: boolean;
  initialError?: string | null;
  initialCard?: Card | null;
  initialCategory?: BacklogCategory;
} = {}) {
  const [overview, setOverview] = useState<BacklogOverview | null>(initialOverview);
  const [selectedCategory, setSelectedCategory] = useState<BacklogCategory>(initialCategory);
  const [card, setCard] = useState<Card | null>(initialCard);
  const [loading, setLoading] = useState(initialLoading);
  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [searchQuery, setSearchQuery] = useState('');
  const [previousAppids, setPreviousAppids] = useState<number[]>([]);
  const [busyAction, setBusyAction] = useState<'play' | 'reroll' | 'not-tonight' | 'steam' | 'exclude' | null>(null);

  // Scan state for achievement degradation
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchBacklogOverview();
      setOverview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load backlog data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialOverview) {
      void loadOverview();
    }
  }, [loadOverview, initialOverview]);

  const handleSpin = async (excludeIds: number[] = previousAppids) => {
    if (spinning) return;
    setSpinning(true);
    setError(null);
    try {
      const res = await fetch('/api/backlog/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: selectedCategory, exclude: excludeIds }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error?.message ?? 'Spin failed');
      }
      if (data.card) {
        setCard(data.card);
        setPreviousAppids(prev => [...prev, data.card.appid]);
      } else {
        setCard(null);
        setError('No eligible games found in this category.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to spin backlog category');
    } finally {
      setSpinning(false);
    }
  };

  const handlePlay = async (c: Card) => {
    if (c.rollId) {
      setBusyAction('play');
      try {
        await fetch('/api/history', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rollId: c.rollId, action: 'accept' }),
        });
      } catch {
        // best effort history update
      } finally {
        setBusyAction(null);
      }
    }
    window.location.href = c.launchUrl;
  };

  const handleReroll = async (c: Card) => {
    setBusyAction('reroll');
    if (c.rollId) {
      try {
        await fetch('/api/history', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rollId: c.rollId, action: 'reroll' }),
        });
      } catch {
        // best effort history update
      }
    }
    const nextExclude = [...new Set([...previousAppids, c.appid])];
    setPreviousAppids(nextExclude);
    await handleSpin(nextExclude);
    setBusyAction(null);
  };

  const handleExcluded = (appid: number) => {
    if (card?.appid === appid) {
      setCard(null);
    }
    void loadOverview();
  };

  const handleScanAchievements = async () => {
    if (scanning) return;
    setScanning(true);
    setScanMessage('Scanning achievements for your library...');
    setScanProgress(null);

    let cursor: string | null = null;
    let complete = false;

    try {
      while (!complete) {
        const res: Response = await fetch('/api/achievements/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cursor }),
        });
        const data: {
          error?: { message?: string };
          progress?: { done: number; total: number };
          state?: string;
          cursor?: string | null;
          message?: string | null;
        } | null = await res.json().catch(() => null);
        if (!res.ok || !data) {
          throw new Error(data?.error?.message ?? 'Achievement scan failed');
        }

        if (data.progress) {
          setScanProgress(data.progress);
        }

        if (data.state === 'complete') {
          complete = true;
          setScanMessage('Achievement scan complete! Backlog updated.');
          await loadOverview();
        } else if (data.state === 'running') {
          cursor = data.cursor ?? null;
        } else if (data.state === 'private') {
          complete = true;
          setScanMessage(data.message ?? 'Steam achievements are private.');
        } else if (data.state === 'rate_limited') {
          complete = true;
          setScanMessage('Scan paused due to Steam rate limit. Please try again in a bit.');
        } else {
          complete = true;
          if (data.message) setScanMessage(data.message);
        }
      }
    } catch (err) {
      setScanMessage(err instanceof Error ? err.message : 'Achievement scan failed');
    } finally {
      setScanning(false);
    }
  };

  if (loading) {
    return (
      <div className="border-4 border-black bg-white p-8 text-center font-bold shadow-neobrutal" role="status">
        <p className="text-xl">Loading your backlog...</p>
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="border-4 border-black bg-neobrutal-pink p-6 font-bold shadow-neobrutal" role="alert">
        <p className="text-xl">Failed to load backlog</p>
        <p className="mt-2 text-sm">{error}</p>
        <button className={`mt-4 ${buttonStyle} bg-white`} onClick={() => void loadOverview()}>
          Try again
        </button>
      </div>
    );
  }

  if (!overview || overview.totalGames === 0) {
    return (
      <div className="border-4 border-black bg-white p-8 shadow-neobrutal">
        <h2 className="text-2xl font-bold">Your library is empty</h2>
        <p className="mt-2 text-zinc-700">
          Sync your Steam games in your Library first to discover your forgotten backlog.
        </p>
        <Link href="/library" className={`mt-4 inline-block ${buttonStyle}`}>
          Go to Library
        </Link>
      </div>
    );
  }

  const activeCategory = overview.categories[selectedCategory];
  const filteredGames = activeCategory.games.filter(g =>
    g.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const isPlaytimeCategory = [
    'never-played',
    'barely-played',
    'not-played-in-a-long-time',
    'started-but-abandoned',
  ].includes(selectedCategory);

  const canSpin =
    activeCategory.status === 'ready' &&
    activeCategory.count > 0 &&
    !spinning;

  return (
    <div className="space-y-6">
      {/* Category Tabs */}
      <nav aria-label="Backlog categories" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {BACKLOG_CATEGORY_IDS.map(id => {
          const cat = overview.categories[id];
          const isSelected = selectedCategory === id;
          const isScanNeeded = cat.status === 'scan_required';

          return (
            <button
              key={id}
              onClick={() => {
                setSelectedCategory(id);
                setCard(null);
                setSearchQuery('');
              }}
              className={`flex flex-col justify-between border-4 border-black p-3 text-left transition-all ${
                isSelected
                  ? 'bg-neobrutal-yellow shadow-neobrutal-sm font-bold scale-[1.02]'
                  : 'bg-white hover:bg-zinc-50'
              }`}
              aria-selected={isSelected}
              role="tab"
            >
              <span className="text-xs uppercase tracking-wide text-zinc-600 sm:text-[0.65rem] font-bold">
                {cat.label}
              </span>
              <div className="mt-2 flex items-center justify-between">
                {isScanNeeded ? (
                  <span className="border-2 border-black bg-neobrutal-pink px-1.5 py-0.5 text-xs font-bold">
                    Scan
                  </span>
                ) : (
                  <span className="text-2xl font-bold leading-none">{cat.count}</span>
                )}
                {isSelected && <span className="h-2 w-2 rounded-full bg-black" aria-hidden />}
              </div>
            </button>
          );
        })}
      </nav>

      {/* Main Category Workspace */}
      <section className="border-4 border-black bg-white p-6 shadow-neobrutal">
        <div className="flex flex-col justify-between gap-4 border-b-4 border-black pb-6 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-2xl font-bold sm:text-3xl">{activeCategory.label}</h2>
            <p className="mt-1 text-zinc-700">{activeCategory.description}</p>
          </div>
          <button
            onClick={() => void handleSpin()}
            disabled={!canSpin}
            className="flex items-center justify-center gap-2 border-4 border-black bg-neobrutal-green px-6 py-3 text-lg font-bold shadow-neobrutal transition-transform hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none disabled:opacity-50 disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-neobrutal"
          >
            {spinning ? (
              <>
                <RefreshCw className="h-5 w-5 animate-spin" />
                <span>Spinning...</span>
              </>
            ) : (
              <>
                <Play className="h-5 w-5 fill-black" />
                <span>Spin this backlog</span>
              </>
            )}
          </button>
        </div>

        {/* Status Notices */}
        {activeCategory.status === 'playtime_hidden' && isPlaytimeCategory && (
          <div className="my-6 flex items-start gap-3 border-4 border-black bg-neobrutal-pink p-4" role="alert">
            <AlertCircle className="h-6 w-6 flex-none" />
            <div>
              <p className="font-bold">Total playtime is private on Steam</p>
              <p className="text-sm mt-1">
                Your Steam privacy settings hide total playtime. Set Game details and Playtime to Public in your Steam
                settings to unlock playtime-based backlog categories.
              </p>
            </div>
          </div>
        )}

        {activeCategory.status === 'scan_required' && (
          <div className="my-6 border-4 border-black bg-neobrutal-yellow p-6 shadow-neobrutal-sm">
            <div className="flex items-start gap-4">
              <Trophy className="h-8 w-8 flex-none" />
              <div>
                <h3 className="text-xl font-bold">Achievement scan required</h3>
                <p className="mt-1 text-sm text-zinc-800">
                  Scan your library achievements to unlock this category and discover games you left unfinished.
                </p>
                <button
                  onClick={() => void handleScanAchievements()}
                  disabled={scanning}
                  className={`mt-4 ${buttonStyle} bg-white flex items-center gap-2`}
                >
                  {scanning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trophy className="h-4 w-4" />}
                  <span>{scanning ? 'Scanning...' : 'Scan achievements to unlock'}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Scan in Progress Bar */}
        {scanning && (
          <div className="my-6 border-4 border-black bg-white p-4" aria-live="polite">
            <div className="flex justify-between font-bold text-sm">
              <span>{scanMessage ?? 'Scanning achievements...'}</span>
              {scanProgress && (
                <span>
                  {scanProgress.done} / {scanProgress.total} (
                  {Math.round((scanProgress.done / Math.max(1, scanProgress.total)) * 100)}%)
                </span>
              )}
            </div>
            <div className="mt-2 h-4 w-full border-2 border-black bg-zinc-100">
              <div
                className="h-full bg-neobrutal-blue transition-all duration-300"
                style={{
                  width: `${
                    scanProgress
                      ? Math.min(100, Math.round((scanProgress.done / Math.max(1, scanProgress.total)) * 100))
                      : 10
                  }%`,
                }}
              />
            </div>
          </div>
        )}

        {scanMessage && !scanning && activeCategory.status !== 'scan_required' && (
          <p className="my-4 text-sm font-bold" role="status">
            {scanMessage}
          </p>
        )}

        {/* Unscanned achievements warning for partially scanned library */}
        {activeCategory.status === 'ready' &&
          (activeCategory.unscannedCount ?? 0) > 0 &&
          (selectedCategory === 'low-completion' || selectedCategory === 'high-completion-but-unfinished') && (
            <div className="my-4 flex items-center justify-between border-2 border-black bg-amber-50 p-3 text-sm">
              <span>
                {activeCategory.unscannedCount} games have not had their achievements scanned yet.
              </span>
              <button
                onClick={() => void handleScanAchievements()}
                disabled={scanning}
                className="underline font-bold hover:text-zinc-700 ml-4 flex-none"
              >
                Scan remaining
              </button>
            </div>
          )}

        {error && (
          <div className="my-4 border-2 border-black bg-neobrutal-pink p-3 font-bold text-sm" role="alert">
            {error}
          </div>
        )}

        {/* Spun Card Result */}
        {card && (
          <div className="my-6 border-t-4 border-black pt-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-pixel text-xs uppercase tracking-wide">Backlog pick</h3>
              <button
                onClick={() => setCard(null)}
                className="text-xs font-bold underline hover:text-zinc-600"
              >
                Dismiss
              </button>
            </div>
            <ExcludableResultCard
              card={card}
              onPlay={handlePlay}
              onReroll={handleReroll}
              onExcluded={handleExcluded}
              busyAction={busyAction}
            />
          </div>
        )}

        {/* Category Games List */}
        <div className="mt-8 border-t-4 border-black pt-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <h3 className="text-xl font-bold">
              Games in this category ({activeCategory.count})
            </h3>
            {activeCategory.count > 0 && (
              <div className="relative w-full sm:w-64">
                <Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Filter by name..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full border-2 border-black py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
            )}
          </div>

          {activeCategory.count === 0 ? (
            <p className="mt-6 py-8 text-center text-zinc-500 font-bold">
              No games currently match this backlog category.
            </p>
          ) : filteredGames.length === 0 ? (
            <p className="mt-6 py-8 text-center text-zinc-500 font-bold">
              No games match &ldquo;{searchQuery}&rdquo;.
            </p>
          ) : (
            <ul className="mt-4 divide-y-2 divide-black border-2 border-black">
              {filteredGames.map(game => (
                <BacklogGameRow
                  key={game.appid}
                  game={game}
                  onSpinThis={() => {
                    void handleSpin([
                      ...overview.categories[selectedCategory].games
                        .filter(g => g.appid !== game.appid)
                        .map(g => g.appid),
                    ]);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function BacklogGameRow({
  game,
  onSpinThis,
}: {
  game: BacklogGameItem;
  onSpinThis: () => void;
}) {
  const iconUrl = game.iconHash
    ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.iconHash}.jpg`
    : null;

  return (
    <li className="flex flex-col justify-between gap-3 p-3 transition-colors hover:bg-zinc-50 sm:flex-row sm:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative h-10 w-10 flex-none overflow-hidden border-2 border-black bg-zinc-200">
          {iconUrl ? (
            <Image
              src={iconUrl}
              alt=""
              width={40}
              height={40}
              className="h-full w-full object-cover"
              unoptimized
            />
          ) : (
            <Gamepad2 className="m-2 h-6 w-6 text-zinc-500" />
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate font-bold text-base">{game.name}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-600">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatPlaytime(game.playtimeForever)}
            </span>
            {game.playtimeForever > 0 && (
              <span>Last: {formatLastPlayed(game.lastPlayedAt, game.playtimeForever, Math.floor(Date.now() / 1000))}</span>
            )}
            {game.achievements && (
              <span className="inline-flex items-center gap-1 font-bold text-black">
                <Trophy className="h-3 w-3" />
                {game.achievements.unlocked}/{game.achievements.total} ({Math.floor(game.achievements.percent)}%)
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 self-end sm:self-center flex-none">
        <button
          onClick={onSpinThis}
          title="Pick this game"
          className="border-2 border-black bg-white px-2 py-1 text-xs font-bold hover:bg-neobrutal-yellow"
        >
          Select
        </button>
        <a
          href={`steam://run/${game.appid}`}
          title="Launch in Steam"
          className="border-2 border-black bg-neobrutal-green px-2 py-1 text-xs font-bold hover:bg-emerald-300"
        >
          Launch
        </a>
        <a
          href={`https://store.steampowered.com/app/${game.appid}`}
          target="_blank"
          rel="noopener noreferrer"
          title="View on Steam store"
          className="border-2 border-black bg-white p-1 hover:bg-zinc-100"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </li>
  );
}
