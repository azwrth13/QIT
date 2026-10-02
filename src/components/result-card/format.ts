import type { ActivityBand, Card, ModeId } from '@/lib/roulette/types';

// Display formatting for the result card. Pure, so the card renders the same on server and client
// for a given `now`. Unknown values stay distinct from zero throughout.

const SECONDS_PER_DAY = 86_400;
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Modes where current player activity leads the card (feature 9). */
export const MULTIPLAYER_MODES: readonly ModeId[] = ['alive-and-kicking', 'everyone-owns-it'];

export const formatCount = (n: number) => numberFormat.format(Math.round(n));

export function formatPlaytime(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m === 0) return 'Never launched';
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  if (hours >= 10) return `${formatCount(m / 60)}h`;
  return m % 60 === 0 ? `${hours}h` : `${hours}h ${m % 60}m`;
}

const plural = (n: number, unit: string) => `${formatCount(n)} ${unit}${n === 1 ? '' : 's'}`;

/** `lastPlayedAt` follows `lastPlayedAt()` in lib/games: 0 means never, null means unknown. */
export function formatLastPlayed(lastPlayedAt: number | null, playtimeForever: number, now: number): string {
  if (lastPlayedAt === null) return playtimeForever > 0 ? 'Unknown' : 'Never';
  if (lastPlayedAt === 0) return 'Never';
  const days = Math.floor(Math.max(0, now - lastPlayedAt) / SECONDS_PER_DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  // 30-day months, as the modes use, so this agrees with reasons such as "haven't played it in 14 months".
  const months = Math.floor(days / 30);
  if (months < 24) return `${plural(months, 'month')} ago`;
  return `${plural(Math.floor(months / 12), 'year')} ago`;
}

export function formatPreviousSelections(count: number): string {
  if (count <= 0) return 'First time QIT picked it';
  return count === 1 ? 'QIT picked it once before' : `QIT picked it ${formatCount(count)} times before`;
}

/** Floors so 99.6% never reads as finished, matching the reasons renderer. */
export function achievementPercent(achievements: NonNullable<Card['achievements']>): number {
  return Math.min(100, Math.max(0, Math.floor(achievements.percent)));
}

/** Only high and low are called out (decision D15); mid and unknown bands show the count alone. */
export function bandLabel(band: ActivityBand | null): string | null {
  if (band === 'high') return 'High activity';
  if (band === 'low') return 'Low activity';
  return null;
}

/** Null when the app has no player counter: no badge at all, never "0 players". */
export function liveSummary(live: Card['live']): { players: string; band: ActivityBand | null; label: string | null } | null {
  if (!live || live.players === null) return null;
  return { players: `${formatCount(live.players)} playing now`, band: live.band, label: bandLabel(live.band) };
}
