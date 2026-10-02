'use client';

import { useId, useState, type ReactNode } from 'react';
import Image from 'next/image';
import { Ban, Clock, ExternalLink, Gamepad2, History, Moon, Play, RefreshCw, Trophy, Users } from 'lucide-react';
import { getMode } from '@/lib/roulette/modes';
import { renderReasons } from '@/lib/roulette/reasons';
import type { Card, PlayerRef } from '@/lib/roulette/types';
import {
  MULTIPLAYER_MODES, achievementPercent, formatCount, formatLastPlayed, formatPlaytime, formatPreviousSelections, liveSummary,
} from './format';

// Presentational result card for one roulette pick (features 8, 9 and 19). Driven only by the `Card`
// DTO: no fetching. Every action is optional and hidden when its handler is missing, so each surface
// (picker, daily, lobby, history) offers just the actions it supports.

export type ResultCardAction = 'play' | 'reroll' | 'not-tonight' | 'steam' | 'exclude';

export interface ResultCardProps {
  card: Card;
  /** Unix seconds; pass it from the server for stable "last played" text. Defaults to the clock. */
  now?: number;
  /** Launches through `card.launchUrl`; the handler records the acceptance. */
  onPlay?: (card: Card) => void;
  onReroll?: (card: Card) => void;
  onNotTonight?: (card: Card) => void;
  /** Opens `card.storeUrl` in a new tab; the handler is notified. */
  onViewOnSteam?: (card: Card) => void;
  /** Adds the game to the temporary exclusion list; the owning surface chooses the scope. */
  onExclude?: (card: Card) => void;
  /** Disables every action while one is in flight and marks that one busy. */
  busyAction?: ResultCardAction | null;
}

export function ResultCard({ card, now, onPlay, onReroll, onNotTonight, onViewOnSteam, onExclude, busyAction = null }: ResultCardProps) {
  const titleId = useId();
  const nowSeconds = now ?? Math.floor(Date.now() / 1000);
  const mode = getMode(card.modeId);
  const live = liveSummary(card.live);
  const liveFirst = MULTIPLAYER_MODES.includes(card.modeId);
  const reasons = renderReasons(card.reasons);
  const hasActions = Boolean(onPlay || onReroll || onNotTonight || onViewOnSteam || onExclude);

  return (
    <article aria-labelledby={titleId} className="w-full border-4 border-black bg-white text-black shadow-neobrutal-lg">
      <header className="flex flex-col border-b-4 border-black bg-neobrutal-yellow sm:flex-row">
        <CardArt key={card.appid} card={card} />
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-3 p-4 sm:p-5">
          <p className="text-xs font-bold uppercase tracking-wide">
            <span className="border-2 border-black bg-white px-2 py-0.5">{mode.label}</span>
          </p>
          <h2 id={titleId} className="break-words text-2xl font-bold leading-tight sm:text-3xl">{card.name}</h2>
          <div className="flex flex-col gap-2">
            {liveFirst && live && <LiveBadge live={live} large />}
            <p className="inline-flex items-center gap-1.5 text-sm font-bold">
              <History aria-hidden className="h-4 w-4 flex-none" />
              {formatPreviousSelections(card.previousSelections)}
            </p>
          </div>
        </div>
      </header>

      <div className="grid gap-0 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {reasons.length > 0 && (
          <section aria-label="Why QIT picked it" className="border-b-4 border-black p-4 sm:p-5 md:border-b-0 md:border-r-4">
            <h3 className="font-pixel text-[0.625rem] uppercase leading-relaxed">Why QIT picked it</h3>
            <ol className="mt-3 space-y-2">
              {reasons.map((text, index) => (
                <li key={card.reasons[index].code} className="flex items-start gap-3">
                  <span aria-hidden className="flex h-7 w-7 flex-none items-center justify-center border-2 border-black bg-neobrutal-blue text-sm font-bold">
                    {index + 1}
                  </span>
                  <span className="pt-0.5 text-base font-bold leading-snug sm:text-lg">{text}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <dl className={`grid grid-cols-2 gap-x-4 gap-y-3 p-4 text-sm sm:p-5 ${reasons.length ? '' : 'md:col-span-2 md:grid-cols-4'}`}>
          <Stat icon={<Clock aria-hidden className="h-4 w-4" />} label="Your playtime" value={formatPlaytime(card.playtimeForever)} />
          <Stat
            icon={<Clock aria-hidden className="h-4 w-4" />}
            label="Last played"
            value={card.lastPlayedAt ? (
              <time dateTime={new Date(card.lastPlayedAt * 1000).toISOString()}>{formatLastPlayed(card.lastPlayedAt, card.playtimeForever, nowSeconds)}</time>
            ) : formatLastPlayed(card.lastPlayedAt, card.playtimeForever, nowSeconds)}
          />
          <div className="col-span-2">
            <dt className="flex items-center gap-1 font-bold"><Trophy aria-hidden className="h-4 w-4" />Achievements</dt>
            <dd className="mt-1"><AchievementValue achievements={card.achievements} /></dd>
          </div>
          {!liveFirst && (
            <div className="col-span-2">
              <dt className="flex items-center gap-1 font-bold"><Users aria-hidden className="h-4 w-4" />Players now</dt>
              <dd className="mt-1">{live ? <LiveBadge live={live} /> : <span className="text-base">No live player count</span>}</dd>
            </div>
          )}
        </dl>
      </div>

      {card.friends && <FriendsStrip friends={card.friends} />}

      {hasActions && (
        <div role="group" aria-label="Result actions" className="grid grid-cols-2 gap-3 border-t-4 border-black bg-[#FFFEF7] p-4 sm:flex sm:flex-wrap sm:items-center">
          {onPlay && (
            <ActionLink
              href={card.launchUrl} busy={busyAction} action="play" onClick={() => onPlay(card)}
              className={`${PRIMARY} col-span-2 bg-neobrutal-green text-lg`}
            >
              <Play aria-hidden className="h-5 w-5 fill-black" />Play this
            </ActionLink>
          )}
          {onReroll && (
            <ActionButton busy={busyAction} action="reroll" onClick={() => onReroll(card)} className={`${PRIMARY} bg-neobrutal-yellow`}>
              <RefreshCw aria-hidden className={`h-5 w-5 ${busyAction === 'reroll' ? 'motion-safe:animate-spin' : ''}`} />
              {busyAction === 'reroll' ? 'Rerolling…' : 'Reroll'}
            </ActionButton>
          )}
          {onNotTonight && (
            <ActionButton busy={busyAction} action="not-tonight" onClick={() => onNotTonight(card)} className={`${PRIMARY} bg-white`}>
              <Moon aria-hidden className="h-5 w-5" />Not tonight
            </ActionButton>
          )}
          {(onViewOnSteam || onExclude) && <span aria-hidden className="hidden flex-1 sm:block" />}
          {onViewOnSteam && (
            <ActionLink
              href={card.storeUrl} external busy={busyAction} action="steam" onClick={() => onViewOnSteam(card)}
              className={`${SECONDARY} bg-white`}
            >
              View on Steam<ExternalLink aria-hidden className="h-4 w-4" /><span className="sr-only"> (opens in a new tab)</span>
            </ActionLink>
          )}
          {onExclude && (
            <ActionButton busy={busyAction} action="exclude" onClick={() => onExclude(card)} className={`${SECONDARY} bg-neobrutal-pink`}>
              <Ban aria-hidden className="h-4 w-4" />Add to exclusions
            </ActionButton>
          )}
        </div>
      )}
    </article>
  );
}

/** Store header art, then the community icon, then a placeholder; a failed image falls through. */
function CardArt({ card }: { card: Card }) {
  const sources = [card.art.header, card.art.icon].filter((src): src is string => Boolean(src));
  const [failed, setFailed] = useState(0);
  const src = sources[failed];
  const isHeader = src !== undefined && src === card.art.header;
  return (
    <div className="relative aspect-[460/215] w-full flex-none overflow-hidden border-b-4 border-black bg-neobrutal-blue sm:w-[46%] sm:border-b-0 sm:border-r-4">
      {src === undefined ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center">
          <Gamepad2 aria-hidden className="h-10 w-10" />
          <span className="text-xs font-bold uppercase">No artwork</span>
        </div>
      ) : isHeader ? (
        // Decorative: the game name is the heading right beside it.
        <Image src={src} alt="" fill priority sizes="(min-width: 640px) 460px, 100vw" className="object-cover" unoptimized onError={() => setFailed(n => n + 1)} />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[repeating-linear-gradient(45deg,#4ECDC4_0_12px,#95E1D3_12px_24px)]">
          <div className="relative h-20 w-20 border-4 border-black bg-white shadow-neobrutal">
            <Image src={src} alt="" fill sizes="80px" className="pixelated object-contain" unoptimized onError={() => setFailed(n => n + 1)} />
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="flex items-center gap-1 font-bold">{icon}{label}</dt>
      <dd className="mt-1 text-base">{value}</dd>
    </div>
  );
}

function AchievementValue({ achievements }: { achievements: Card['achievements'] }) {
  if (!achievements || achievements.total <= 0) return <span className="text-base">No achievement data</span>;
  const percent = achievementPercent(achievements);
  return (
    <div className="space-y-1">
      <p className="text-base"><strong className="text-lg">{percent}%</strong> · {formatCount(achievements.unlocked)} of {formatCount(achievements.total)} unlocked</p>
      <div aria-hidden className="h-3 w-full border-2 border-black bg-white">
        <div className="h-full bg-neobrutal-purple" style={{ width: `${percent}%`, backgroundColor: percent === 100 ? '#FFE66D' : undefined }} />
      </div>
    </div>
  );
}

const BAND_STYLES = { high: 'bg-neobrutal-green', low: 'bg-neobrutal-pink', mid: 'bg-white' } as const;

function LiveBadge({ live, large = false }: { live: NonNullable<ReturnType<typeof liveSummary>>; large?: boolean }) {
  return (
    <p className={`inline-flex w-fit flex-wrap items-center gap-2 font-bold ${large ? 'text-base' : 'text-sm'}`}>
      <span className={`inline-flex items-center gap-1.5 border-2 border-black bg-white px-2 py-0.5 ${large ? 'shadow-neobrutal-sm' : ''}`}>
        <span aria-hidden className="h-2.5 w-2.5 rounded-full border-2 border-black bg-neobrutal-green" />
        {live.players}
      </span>
      {live.label && live.band && (
        <span className={`border-2 border-black px-2 py-0.5 uppercase ${BAND_STYLES[live.band]} ${large ? 'shadow-neobrutal-sm' : ''}`}>{live.label}</span>
      )}
    </p>
  );
}

function FriendsStrip({ friends }: { friends: NonNullable<Card['friends']> }) {
  const groups: [string, PlayerRef[]][] = [
    ['Own it', friends.owners],
    ['Have played it', friends.playedBy],
    ['Never played it', friends.neverPlayedBy],
  ];
  return (
    <section aria-label="Friends" className="border-t-4 border-black p-4 sm:p-5">
      <h3 className="font-pixel text-[0.625rem] uppercase leading-relaxed">Friends</h3>
      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        {groups.map(([label, players]) => (
          <div key={label}>
            <dt className="text-sm font-bold">{label} <span className="font-normal">({players.length})</span></dt>
            <dd className="mt-1">
              {players.length === 0 ? <span className="text-sm">Nobody</span> : (
                <ul className="flex flex-wrap gap-1.5">
                  {players.map(player => <PlayerChip key={player.steamId} player={player} />)}
                </ul>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const MONOGRAM_COLORS = ['bg-neobrutal-yellow', 'bg-neobrutal-blue', 'bg-neobrutal-pink', 'bg-neobrutal-green'];

function PlayerChip({ player }: { player: PlayerRef }) {
  const color = MONOGRAM_COLORS[Number(player.steamId.slice(-2)) % MONOGRAM_COLORS.length] ?? MONOGRAM_COLORS[0];
  return (
    <li className="inline-flex max-w-full items-center gap-1.5 border-2 border-black bg-white pr-2 text-sm font-bold">
      {player.avatar ? (
        <Image src={player.avatar} alt="" width={24} height={24} className="h-6 w-6 border-r-2 border-black" unoptimized />
      ) : (
        <span aria-hidden className={`flex h-6 w-6 flex-none items-center justify-center border-r-2 border-black text-xs ${color}`}>
          {player.name.trim().charAt(0).toUpperCase() || '?'}
        </span>
      )}
      <span className="truncate">{player.name}</span>
    </li>
  );
}

const ACTION_BASE = 'inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap border-black py-2 font-bold transition-transform sm:gap-2'
  + ' hover:-translate-x-0.5 hover:-translate-y-0.5 active:translate-x-0.5 active:translate-y-0.5 active:shadow-none';
const PRIMARY = 'border-4 px-3 shadow-neobrutal sm:px-4';
const SECONDARY = 'border-2 px-2 text-sm shadow-neobrutal-sm sm:px-3';
const ACTION_DISABLED = 'cursor-not-allowed opacity-60 hover:translate-x-0 hover:translate-y-0';

interface ActionProps {
  action: ResultCardAction;
  busy: ResultCardAction | null;
  onClick: () => void;
  className: string;
  children: ReactNode;
}

function ActionButton({ action, busy, onClick, className, children }: ActionProps) {
  return (
    <button
      type="button" onClick={onClick} disabled={busy !== null} aria-busy={busy === action || undefined}
      className={`${ACTION_BASE} ${className} ${busy !== null ? ACTION_DISABLED : ''}`}
    >
      {children}
    </button>
  );
}

function ActionLink({ action, busy, onClick, className, children, href, external = false }: ActionProps & { href: string; external?: boolean }) {
  const disabled = busy !== null;
  return (
    <a
      href={disabled ? undefined : href} onClick={disabled ? undefined : onClick} aria-disabled={disabled || undefined} aria-busy={busy === action || undefined}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={`${ACTION_BASE} ${className} ${disabled ? ACTION_DISABLED : ''}`}
    >
      {children}
    </a>
  );
}
