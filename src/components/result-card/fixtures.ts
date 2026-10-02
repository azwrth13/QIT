import { launchUrlOf, storeUrlOf } from '@/lib/roulette/card';
import { reason } from '@/lib/roulette/reasons';
import type { Card, PlayerRef } from '@/lib/roulette/types';
import { steamHeaderImageUrl, steamIconUrl } from '@/lib/steam/urls';
import type { ResultCardAction } from './ResultCard';

// Fixture cards for every result card state. Rendered by /fixtures/result-card and the card tests,
// because live data for most fields only arrives with later packages (spin API, group UI).

/** 2026-10-02T18:00:00Z; every fixture's "last played" text is relative to this. */
export const FIXTURE_NOW = 1_790_964_000;
const MONTH = 30 * 86_400;

export type FixtureActions = 'all' | 'play-and-steam' | 'none';

export interface ResultCardFixture {
  id: string;
  title: string;
  card: Card;
  actions: FixtureActions;
  busyAction?: ResultCardAction;
}

const player = (steamId: string, name: string): PlayerRef => ({ steamId, name, avatar: null });
const ALEX = player('76561198000000011', 'Alex');
const SAM = player('76561198000000022', 'Sam the Destroyer');
const JORDAN = player('76561198000000033', 'Jordan');
const RIO = player('76561198000000040', 'rio');

function card(appid: number, name: string, overrides: Partial<Card>): Card {
  return {
    appid,
    name,
    modeId: 'pure-random',
    rollId: `fixture-${appid}`,
    art: { header: steamHeaderImageUrl(appid), icon: null },
    reasons: [reason('random_pick', {})],
    playtimeForever: 0,
    lastPlayedAt: 0,
    achievements: null,
    live: null,
    friends: null,
    previousSelections: 0,
    storeUrl: storeUrlOf(appid),
    launchUrl: launchUrlOf(appid),
    ...overrides,
  };
}

export const RESULT_CARD_FIXTURES: readonly ResultCardFixture[] = [
  {
    id: 'full',
    title: 'Full data: every field, four reasons (top three shown), friends, all actions',
    actions: 'all',
    card: card(548430, 'Deep Rock Galactic', {
      modeId: 'rediscovery',
      reasons: [
        reason('rediscovery', { hours: 64, months: 14 }),
        reason('ach_remaining', { remaining: 19, total: 50 }),
        reason('active_now', { players: 8412, band: 'high' }),
        reason('not_rolled_recently', {}),
      ],
      playtimeForever: 3_847,
      lastPlayedAt: FIXTURE_NOW - 14 * MONTH,
      achievements: { unlocked: 31, total: 50, percent: 62 },
      live: { players: 8_412, band: 'high' },
      friends: { owners: [ALEX, SAM, JORDAN], playedBy: [ALEX, SAM], neverPlayedBy: [JORDAN] },
      previousSelections: 3,
    }),
  },
  {
    id: 'missing-art',
    title: 'Missing header art: falls back to the community icon',
    actions: 'all',
    card: card(620, 'Portal 2', {
      modeId: 'dust-collector',
      art: { header: null, icon: steamIconUrl(620, '25a5a16b2423bf7487ac5340b5b0948cef48c5f8') },
      reasons: [reason('never_launched', {}), reason('not_rolled_recently', {})],
      achievements: { unlocked: 0, total: 51, percent: 0 },
      live: { players: 1_904, band: 'mid' },
    }),
  },
  {
    id: 'no-art',
    title: 'No header art and no icon: placeholder',
    actions: 'all',
    card: card(2_000_000, 'Untitled Indie Prototype', {
      modeId: 'something-different',
      art: { header: null, icon: null },
      reasons: [reason('barely_played', { minutes: 25 }), reason('outside_rotation', {})],
      playtimeForever: 25,
      lastPlayedAt: FIXTURE_NOW - 26 * MONTH,
      live: { players: null, band: null },
    }),
  },
  {
    id: 'no-achievements',
    title: 'No achievement data',
    actions: 'all',
    card: card(413150, 'Stardew Valley', {
      modeId: 'comfort-pick',
      reasons: [reason('comfort', { hours: 212 }), reason('outside_rotation', {})],
      playtimeForever: 12_730,
      lastPlayedAt: FIXTURE_NOW - 3 * MONTH,
      achievements: null,
      live: { players: 41_388, band: 'high' },
      previousSelections: 1,
    }),
  },
  {
    id: 'no-player-counter',
    title: 'No player counter: no activity badge, never "0 players"',
    actions: 'all',
    card: card(367520, 'Hollow Knight', {
      modeId: 'finish-something',
      reasons: [reason('ach_near_complete', { percent: 91.4, remaining: 4 }), reason('idle', { months: 5 })],
      playtimeForever: 2_310,
      lastPlayedAt: FIXTURE_NOW - 5 * MONTH,
      achievements: { unlocked: 59, total: 63, percent: 91.4 },
      live: { players: null, band: null },
    }),
  },
  {
    id: 'activity-high',
    title: 'Multiplayer mode, high activity: badge leads the card',
    actions: 'all',
    card: card(440, 'Team Fortress 2', {
      modeId: 'alive-and-kicking',
      reasons: [reason('active_now', { players: 61_250, band: 'high' })],
      playtimeForever: 9_120,
      lastPlayedAt: FIXTURE_NOW - 3 * 86_400,
      achievements: { unlocked: 112, total: 520, percent: 21.5 },
      live: { players: 61_250, band: 'high' },
      previousSelections: 2,
    }),
  },
  {
    id: 'activity-low',
    title: 'Multiplayer mode, low activity',
    actions: 'all',
    card: card(489830, 'The Elder Scrolls V: Skyrim Special Edition', {
      modeId: 'alive-and-kicking',
      reasons: [reason('active_now', { players: 140, band: 'low' }), reason('not_rolled_recently', {})],
      playtimeForever: 655,
      lastPlayedAt: FIXTURE_NOW - 8 * 86_400,
      achievements: { unlocked: 12, total: 75, percent: 16 },
      live: { players: 140, band: 'low' },
    }),
  },
  {
    id: 'activity-none',
    title: 'Multiplayer mode, players counted but no high or low band',
    actions: 'all',
    card: card(1_145_360, 'Hades', {
      modeId: 'alive-and-kicking',
      reasons: [reason('active_now', { players: 3_120, band: 'mid' })],
      playtimeForever: 1_455,
      lastPlayedAt: FIXTURE_NOW - 2 * MONTH,
      achievements: { unlocked: 30, total: 49, percent: 61.2 },
      live: { players: 3_120, band: 'mid' },
    }),
  },
  {
    id: 'friends-present',
    title: 'Everyone Owns It with four players: who owns it and who has played it',
    actions: 'all',
    card: card(105_600, 'Terraria', {
      modeId: 'everyone-owns-it',
      reasons: [reason('friends_all_own', { count: 4 }), reason('friends_never_played', { count: 2 }), reason('active_now', { players: 27_904, band: 'high' })],
      playtimeForever: 480,
      lastPlayedAt: FIXTURE_NOW - 26 * MONTH,
      achievements: { unlocked: 14, total: 88, percent: 15.9 },
      live: { players: 27_904, band: 'high' },
      friends: { owners: [ALEX, SAM, JORDAN, RIO], playedBy: [ALEX, SAM], neverPlayedBy: [JORDAN, RIO] },
      previousSelections: 1,
    }),
  },
  {
    id: 'friends-absent',
    title: 'Solo pick: no friends section',
    actions: 'all',
    card: card(1_086_940, "Baldur's Gate 3", {
      modeId: 'pure-random',
      reasons: [reason('random_pick', {})],
      playtimeForever: 95,
      lastPlayedAt: FIXTURE_NOW - 1 * 86_400,
      achievements: { unlocked: 2, total: 54, percent: 3.7 },
      live: { players: 52_700, band: 'high' },
    }),
  },
  {
    id: 'many-selections',
    title: 'Several previous QIT selections',
    actions: 'all',
    card: card(548430, 'Deep Rock Galactic', {
      modeId: 'achievement-hunter',
      reasons: [reason('ach_remaining', { remaining: 19, total: 50 }), reason('rare_remaining', { count: 6, threshold: 10 })],
      playtimeForever: 3_847,
      lastPlayedAt: FIXTURE_NOW - 14 * MONTH,
      achievements: { unlocked: 31, total: 50, percent: 62 },
      live: { players: 8_412, band: 'high' },
      previousSelections: 12,
    }),
  },
  {
    id: 'actions-partial',
    title: 'Only Play this and View on Steam have handlers (for example history)',
    actions: 'play-and-steam',
    card: card(367520, 'Hollow Knight', {
      modeId: 'finish-something',
      reasons: [reason('ach_near_complete', { percent: 91.4, remaining: 4 })],
      playtimeForever: 2_310,
      lastPlayedAt: FIXTURE_NOW - 5 * MONTH,
      achievements: { unlocked: 63, total: 63, percent: 100 },
      live: { players: 4_870, band: 'mid' },
      previousSelections: 2,
    }),
  },
  {
    id: 'actions-none',
    title: 'No handlers: the actions row is hidden',
    actions: 'none',
    card: card(413150, 'Stardew Valley', {
      modeId: 'pure-random',
      playtimeForever: 12_730,
      lastPlayedAt: FIXTURE_NOW - 3 * MONTH,
      live: { players: 41_388, band: 'high' },
    }),
  },
  {
    id: 'busy-reroll',
    title: 'Reroll in flight: actions disabled',
    actions: 'all',
    busyAction: 'reroll',
    card: card(440, 'Team Fortress 2', {
      modeId: 'dust-collector',
      reasons: [reason('idle', { months: 30 }), reason('barely_played', { minutes: 75 })],
      playtimeForever: 75,
      lastPlayedAt: null,
      live: { players: 61_250, band: 'high' },
    }),
  },
];
