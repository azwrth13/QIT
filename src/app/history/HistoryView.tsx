'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { CheckCircle2, Clock, ExternalLink, Gamepad2, Play, RefreshCw, X } from 'lucide-react';
import { ExcludableResultCard } from '@/components/result-card/ExcludableResultCard';
import { formatPlaytime } from '@/components/result-card/format';
import { getMode, isModeId } from '@/lib/roulette/modes';
import { renderReasons } from '@/lib/roulette/reasons';
import type { Card, FilterSelection, Reason, Scope } from '@/lib/roulette/types';
import { THRESHOLDS } from '@/lib/roulette/thresholds';
import { buildRerollFilters } from '@/lib/history/reroll-filters';

const ANTI_REPEAT_OPTIONS = THRESHOLDS.antiRepeatDayOptions;
const DEFAULT_ANTI_REPEAT_DAYS = THRESHOLDS.antiRepeatDays;

export interface RollItem {
  id: string;
  appid: number;
  name: string | null;
  modeId: string;
  filters: FilterSelection[];
  scope: Scope | null;
  participants: string[];
  lobbyId: string | null;
  at: string;
  status: 'rolled' | 'accepted' | 'rerolled';
  acceptedAt: string | null;
  rerolledAt: string | null;
  playedAt: string | null;
  playedSource: 'sync' | 'manual' | null;
  playtimeAtRoll: number | null;
  reasons: Reason[];
}

export interface HistoryResponse {
  rolls: RollItem[];
  nextCursor: string | null;
}

export interface AntiRepeatResponse {
  days: number;
  options: readonly number[];
  defaultDays: number;
}

const buttonPrimary = 'inline-flex items-center gap-1.5 border-2 border-black bg-neobrutal-yellow px-3 py-1.5 font-bold shadow-[2px_2px_0_0_#000] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0_0_#000] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-50 text-sm';
const buttonSuccess = 'inline-flex items-center gap-1.5 border-2 border-black bg-neobrutal-green px-3 py-1.5 font-bold shadow-[2px_2px_0_0_#000] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0_0_#000] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-50 text-sm';
const buttonSecondary = 'inline-flex items-center gap-1.5 border-2 border-black bg-white px-3 py-1.5 font-bold shadow-[2px_2px_0_0_#000] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0_0_#000] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-50 text-sm';

export default function HistoryView() {
  const [rolls, setRolls] = useState<RollItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  // Anti-repeat window setting (D6)
  const [antiRepeatDays, setAntiRepeatDays] = useState<number>(DEFAULT_ANTI_REPEAT_DAYS);
  const [antiRepeatSaving, setAntiRepeatSaving] = useState(false);
  const [antiRepeatMessage, setAntiRepeatMessage] = useState('');

  // View filtering: 'all' vs 'played'
  const [activeTab, setActiveTab] = useState<'all' | 'played'>('all');

  // Active re-roll result card (Feature 19)
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [rerollBusy, setRerollBusy] = useState(false);
  const [actionBusyRollId, setActionBusyRollId] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch('/api/history?limit=20', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Unable to load recommendation history');
      setRolls(data.rolls ?? []);
      setNextCursor(data.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/history?limit=20&cursor=${encodeURIComponent(nextCursor)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Unable to load more rolls');
      setRolls(prev => [...prev, ...(data.rolls ?? [])]);
      setNextCursor(data.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more');
    } finally {
      setLoadingMore(false);
    }
  };

  const loadAntiRepeat = useCallback(async () => {
    try {
      const response = await fetch('/api/history/anti-repeat', { cache: 'no-store' });
      const data = await response.json();
      if (response.ok && typeof data.days === 'number') {
        setAntiRepeatDays(data.days);
      }
    } catch {
      // Keep default
    }
  }, []);

  useEffect(() => {
    Promise.all([loadHistory(), loadAntiRepeat()]).catch(() => {});
  }, [loadHistory, loadAntiRepeat]);

  const handleUpdateAntiRepeat = async (days: number) => {
    setAntiRepeatSaving(true);
    setAntiRepeatMessage('');
    try {
      const res = await fetch('/api/history/anti-repeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? 'Unable to save setting');
      setAntiRepeatDays(data.days);
      setAntiRepeatMessage(`Anti-repeat window saved: ${days === 0 ? 'Off' : `${days} days`}`);
    } catch (err) {
      setAntiRepeatMessage(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setAntiRepeatSaving(false);
    }
  };

  const handleMarkPlayed = async (rollId: string) => {
    setActionBusyRollId(rollId);
    setError('');
    setFeedback('');
    try {
      const res = await fetch('/api/history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rollId, action: 'played' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? 'Unable to mark as played');
      setRolls(prev => prev.map(r => r.id === rollId ? { ...r, playedAt: new Date().toISOString(), playedSource: 'manual' } : r));
      setFeedback('Marked recommendation as played!');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark as played');
    } finally {
      setActionBusyRollId(null);
    }
  };

  const handleRerollSession = async (roll: RollItem) => {
    setRerollBusy(true);
    setError('');
    setFeedback('');
    try {
      if (roll.status === 'rolled') {
        await fetch('/api/history', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rollId: roll.id, action: 'reroll' }),
        }).catch(() => {});
      }

      const filters = buildRerollFilters(roll.filters, antiRepeatDays);

      const spinRes = await fetch('/api/roulette/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: roll.modeId,
          filters,
          scope: roll.scope ?? { kind: 'library' },
        }),
      });
      const spinData = await spinRes.json();
      if (!spinRes.ok) throw new Error(spinData.error?.message ?? 'Re-roll failed');

      if (!spinData.card) {
        setFeedback('No eligible games found for these settings and exclusions.');
        setActiveCard(null);
      } else {
        setActiveCard(spinData.card);
        setFeedback(`Re-roll selected: ${spinData.card.name}!`);
        void loadHistory();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to re-roll from session');
    } finally {
      setRerollBusy(false);
    }
  };

  const handleCardPlay = (card: Card) => {
    window.location.href = card.launchUrl;
    if (card.rollId) {
      fetch('/api/history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rollId: card.rollId, action: 'accept' }),
      }).catch(() => {});
    }
    setFeedback(`Launching ${card.name} on Steam!`);
  };

  const handleCardReroll = (card: Card) => {
    if (card.rollId) {
      fetch('/api/history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rollId: card.rollId, action: 'reroll' }),
      }).catch(() => {});
    }
    // Re-roll again with current card mode
    const fakeRoll: RollItem = {
      id: card.rollId ?? 'current',
      appid: card.appid,
      name: card.name,
      modeId: card.modeId,
      filters: [],
      scope: { kind: 'library' },
      participants: [],
      lobbyId: null,
      at: new Date().toISOString(),
      status: 'rolled',
      acceptedAt: null,
      rerolledAt: null,
      playedAt: null,
      playedSource: null,
      playtimeAtRoll: card.playtimeForever,
      reasons: card.reasons,
    };
    void handleRerollSession(fakeRoll);
  };

  const playedRolls = rolls.filter(r => r.playedAt !== null);
  const displayedRolls = activeTab === 'played' ? playedRolls : rolls;

  return (
    <div className="space-y-6">
      {/* Notifications / Errors */}
      {error && (
        <div role="alert" className="border-4 border-black bg-neobrutal-pink p-4 font-bold text-black shadow-[4px_4px_0_0_#000]">
          <p>{error}</p>
          <button className="mt-2 underline" onClick={() => { setError(''); void loadHistory(); }}>Dismiss</button>
        </div>
      )}
      {feedback && (
        <div role="status" className="border-4 border-black bg-neobrutal-green p-4 font-bold text-black shadow-[4px_4px_0_0_#000]">
          <p>{feedback}</p>
        </div>
      )}

      {/* Active re-roll recommendation card (Feature 19) */}
      {activeCard && (
        <section aria-label="Latest re-roll recommendation" className="relative border-4 border-black bg-white p-4 shadow-[6px_6px_0_0_#000]">
          <div className="mb-3 flex items-center justify-between border-b-2 border-black pb-2">
            <h2 className="flex items-center gap-2 text-xl font-bold uppercase tracking-wide">
              <Gamepad2 className="h-5 w-5" />
              Latest Re-Roll Recommendation
            </h2>
            <button
              onClick={() => setActiveCard(null)}
              aria-label="Dismiss recommendation"
              className="border-2 border-black p-1 hover:bg-neobrutal-pink"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <ExcludableResultCard
            card={activeCard}
            onPlay={handleCardPlay}
            onReroll={handleCardReroll}
            onViewOnSteam={card => window.open(card.storeUrl, '_blank')}
            onExcluded={() => void loadHistory()}
            busyAction={rerollBusy ? 'reroll' : null}
          />
        </section>
      )}

      {/* Anti-repeat window settings (Feature 13 & Decision D6) */}
      <section aria-label="Avoid recent settings" className="border-4 border-black bg-white p-5 shadow-[4px_4px_0_0_#000]">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-bold">Avoid recent recommendations</h2>
            <p className="text-sm text-gray-700">
              Prevent games QIT recommended recently from appearing again when you re-roll from history (Decision D6).
            </p>
          </div>
          {antiRepeatMessage && (
            <p role="status" className="text-sm font-bold text-black">
              {antiRepeatMessage}
            </p>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {ANTI_REPEAT_OPTIONS.map(days => {
            const isSelected = antiRepeatDays === days;
            const label = days === 0 ? 'Off' : `${days} days${days === 30 ? ' (default)' : ''}`;
            return (
              <button
                key={days}
                disabled={antiRepeatSaving}
                onClick={() => void handleUpdateAntiRepeat(days)}
                className={`border-2 border-black px-4 py-2 font-bold text-sm shadow-[2px_2px_0_0_#000] ${
                  isSelected ? 'bg-neobrutal-yellow text-black' : 'bg-white text-black hover:bg-gray-100'
                } disabled:opacity-50`}
                aria-pressed={isSelected}
              >
                {label}
              </button>
            );
          })}
        </div>
      </section>

      {/* View Tabs: All recommendations vs Played games */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b-4 border-black pb-2">
        <div className="flex gap-2" role="tablist">
          <button
            role="tab"
            onClick={() => setActiveTab('all')}
            className={`border-4 border-black px-4 py-2 font-bold text-sm ${
              activeTab === 'all'
                ? 'bg-neobrutal-yellow shadow-[3px_3px_0_0_#000]'
                : 'bg-white hover:bg-gray-100'
            }`}
            aria-selected={activeTab === 'all'}
          >
            All recommendations ({rolls.length} loaded)
          </button>
          <button
            role="tab"
            onClick={() => setActiveTab('played')}
            className={`border-4 border-black px-4 py-2 font-bold text-sm ${
              activeTab === 'played'
                ? 'bg-neobrutal-green shadow-[3px_3px_0_0_#000]'
                : 'bg-white hover:bg-gray-100'
            }`}
            aria-selected={activeTab === 'played'}
          >
            Played games ({playedRolls.length} loaded)
          </button>
        </div>
      </div>

      {/* Rolls List */}
      {loading ? (
        <p role="status" className="p-4 text-center font-bold">
          Loading your recommendation history…
        </p>
      ) : displayedRolls.length === 0 ? (
        <div className="border-4 border-black bg-white p-8 text-center shadow-[4px_4px_0_0_#000]">
          {activeTab === 'played' ? (
            <>
              <p className="text-lg font-bold">No recommendations marked as played yet.</p>
              <p className="mt-2 text-sm text-gray-700">
                Play recommended games or click &ldquo;Mark as played&rdquo; on any recommendation to see them here.
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-bold">No recommendations recorded yet.</p>
              <p className="mt-2 text-sm text-gray-700">
                Spin the roulette picker in your library to start building your history!
              </p>
              <Link href="/library" className={`mt-4 ${buttonPrimary}`}>
                Go to library picker
              </Link>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {displayedRolls.map(roll => {
            const mode = isModeId(roll.modeId) ? getMode(roll.modeId) : null;
            const reasons = renderReasons(roll.reasons);
            const isPlayed = Boolean(roll.playedAt);
            const isAccepted = roll.status === 'accepted';
            const isRerolled = roll.status === 'rerolled';
            const isFriendNight = (roll.scope?.kind === 'friends') || (roll.participants && roll.participants.length > 1);
            const storeUrl = `https://store.steampowered.com/app/${roll.appid}`;
            const launchUrl = `steam://run/${roll.appid}`;
            const headerArt = `https://cdn.cloudflare.steamstatic.com/steam/apps/${roll.appid}/header.jpg`;
            const isBusy = actionBusyRollId === roll.id || rerollBusy;

            return (
              <article
                key={roll.id}
                className="border-4 border-black bg-white text-black shadow-[4px_4px_0_0_#000]"
                aria-label={`Recommendation: ${roll.name ?? roll.appid}`}
              >
                <div className="flex flex-col md:flex-row">
                  {/* Thumbnail art */}
                  <div className="relative h-32 w-full flex-none border-b-4 border-black bg-black sm:h-36 md:w-56 md:border-b-0 md:border-r-4">
                    <Image
                      src={headerArt}
                      alt=""
                      fill
                      unoptimized
                      className="object-cover"
                    />
                  </div>

                  {/* Body */}
                  <div className="flex min-w-0 flex-1 flex-col justify-between p-4 sm:p-5">
                    <div>
                      {/* Top Badges */}
                      <div className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-wider">
                        <span className="border-2 border-black bg-neobrutal-yellow px-2 py-0.5">
                          {mode?.label ?? roll.modeId}
                        </span>
                        {isAccepted && (
                          <span className="border-2 border-black bg-neobrutal-green px-2 py-0.5">
                            Accepted
                          </span>
                        )}
                        {isRerolled && (
                          <span className="border-2 border-black bg-gray-200 px-2 py-0.5">
                            Rerolled
                          </span>
                        )}
                        {isPlayed && (
                          <span className="border-2 border-black bg-neobrutal-green px-2 py-0.5">
                            Played {roll.playedSource === 'sync' ? '(auto-detected)' : '(manual)'}
                          </span>
                        )}
                        {isFriendNight && (
                          <span className="border-2 border-black bg-neobrutal-blue px-2 py-0.5">
                            Friend Night ({roll.participants.length} players)
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1 text-gray-600">
                          <Clock className="h-3.5 w-3.5" />
                          {new Date(roll.at).toLocaleDateString()}
                        </span>
                      </div>

                      {/* Game Title */}
                      <h3 className="mt-2 text-xl font-bold leading-tight sm:text-2xl">
                        {roll.name ?? `Steam App ${roll.appid}`}
                      </h3>

                      {/* Playtime info */}
                      {roll.playtimeAtRoll !== null && (
                        <p className="mt-1 text-xs text-gray-700">
                          Playtime at recommendation: <span className="font-bold">{formatPlaytime(roll.playtimeAtRoll)}</span>
                        </p>
                      )}

                      {/* Reasons */}
                      {reasons.length > 0 && (
                        <div className="mt-3 border-t-2 border-black/10 pt-2">
                          <p className="text-xs font-bold uppercase text-gray-500">Why QIT picked it</p>
                          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm font-semibold">
                            {reasons.slice(0, 3).map((text, i) => (
                              <li key={i}>{text}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    {/* Actions row */}
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t-2 border-black pt-3">
                      <button
                        disabled={isBusy}
                        onClick={() => void handleRerollSession(roll)}
                        className={buttonPrimary}
                      >
                        <RefreshCw className={`h-4 w-4 ${isBusy ? 'motion-safe:animate-spin' : ''}`} />
                        Re-roll from this session
                      </button>

                      {!isPlayed && (
                        <button
                          disabled={isBusy}
                          onClick={() => void handleMarkPlayed(roll.id)}
                          className={buttonSuccess}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          Mark as played
                        </button>
                      )}

                      <a
                        href={launchUrl}
                        onClick={() => {
                          if (roll.status === 'rolled') {
                            void fetch('/api/history', {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ rollId: roll.id, action: 'accept' }),
                            }).catch(() => {});
                          }
                        }}
                        className={buttonSecondary}
                      >
                        <Play className="h-4 w-4 fill-black" />
                        Play this
                      </a>

                      <a
                        href={storeUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={buttonSecondary}
                      >
                        <ExternalLink className="h-4 w-4" />
                        View on Steam
                      </a>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}

          {/* Pagination */}
          {nextCursor && (
            <div className="pt-2 text-center">
              <button
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className={`${buttonPrimary} text-base`}
              >
                {loadingMore ? 'Loading older recommendations…' : 'Load more recommendations'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
