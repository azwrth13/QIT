import { steamIconUrl } from '../steam/urls';
import { CARD_REASON_LIMIT } from './reasons';
import type { ScoredCandidate } from './scoring';
import type { Card, ModeId } from './types';

// Turns the drawn game into the `Card` DTO the result card renders. Pure.

export interface CardExtras {
  modeId: ModeId;
  /** null when the roll could not be stored. */
  rollId: string | null;
  /** Store header art; null lets the card fall back to the icon. */
  header: string | null;
}

export const storeUrlOf = (appid: number) => `https://store.steampowered.com/app/${appid}`;
export const launchUrlOf = (appid: number) => `steam://run/${appid}`;

export function buildCard({ candidate, reasons }: ScoredCandidate, { modeId, rollId, header }: CardExtras): Card {
  const { appid, signals } = candidate;
  const { library } = signals;
  const achievements = signals.achievements
    ? { unlocked: signals.achievements.unlocked, total: signals.achievements.total, percent: signals.achievements.percent }
    : null;
  return {
    appid,
    name: library.name,
    modeId,
    rollId,
    art: { header, icon: library.iconHash ? steamIconUrl(appid, library.iconHash) : null },
    reasons: reasons.slice(0, CARD_REASON_LIMIT),
    playtimeForever: library.playtimeForever,
    lastPlayedAt: library.lastPlayedAt,
    achievements,
    live: signals.live ?? null,
    // Names and avatars for owners come from the group scopes' packages; the library scope has no other players.
    friends: null,
    // Rolls inside the history window, before this one.
    previousSelections: signals.history?.timesRolled ?? 0,
    storeUrl: storeUrlOf(appid),
    launchUrl: launchUrlOf(appid),
  };
}
