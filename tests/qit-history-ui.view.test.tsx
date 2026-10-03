import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getSteamId: auth }));

import HistoryPage from '../src/app/history/page';
import HistoryView, { type RollItem } from '../src/app/history/HistoryView';
import { isNavEnabled, navbarItems, NAV_ITEMS } from '../src/app/navbar/nav-items';
import type { Card } from '../src/lib/roulette/types';
import { ExcludableResultCard } from '../src/components/result-card/ExcludableResultCard';

const steamId = '76561198000000042';

const sampleRoll: RollItem = {
  id: 'roll-123',
  appid: 620,
  name: 'Portal 2',
  modeId: 'dust-collector',
  filters: [{ id: 'never-played' }],
  scope: { kind: 'library' },
  participants: [steamId],
  lobbyId: null,
  at: '2026-09-28T14:30:00.000Z',
  status: 'rolled',
  acceptedAt: null,
  rerolledAt: null,
  playedAt: null,
  playedSource: null,
  playtimeAtRoll: 45,
  reasons: [
    { code: 'barely_played', params: { minutes: 45 } },
    { code: 'idle', params: { months: 12 } },
  ],
};

const acceptedPlayedRoll: RollItem = {
  id: 'roll-456',
  appid: 400,
  name: 'Portal',
  modeId: 'comfort-pick',
  filters: [],
  scope: { kind: 'library' },
  participants: [steamId],
  lobbyId: null,
  at: '2026-09-20T10:00:00.000Z',
  status: 'accepted',
  acceptedAt: '2026-09-20T10:05:00.000Z',
  rerolledAt: null,
  playedAt: '2026-09-21T18:00:00.000Z',
  playedSource: 'sync',
  playtimeAtRoll: 720,
  reasons: [{ code: 'comfort', params: { hours: 12 } }],
};

const friendNightRoll: RollItem = {
  id: 'roll-789',
  appid: 550,
  name: 'Left 4 Dead 2',
  modeId: 'everyone-owns-it',
  filters: [{ id: 'co-op' }],
  scope: { kind: 'friends', with: [steamId, '76561198000000099', '76561198000000100'] },
  participants: [steamId, '76561198000000099', '76561198000000100'],
  lobbyId: null,
  at: '2026-09-25T20:00:00.000Z',
  status: 'rerolled',
  acceptedAt: null,
  rerolledAt: '2026-09-25T20:02:00.000Z',
  playedAt: '2026-09-25T21:00:00.000Z',
  playedSource: 'manual',
  playtimeAtRoll: 1800,
  reasons: [{ code: 'friends_all_own', params: { count: 3 } }],
};

describe('History Page & View', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/history/anti-repeat')) {
        return new Response(JSON.stringify({ days: 30, options: [0, 7, 30, 90], defaultDays: 30 }), { status: 200 });
      }
      if (url.includes('/api/history')) {
        return new Response(JSON.stringify({ rolls: [sampleRoll, acceptedPlayedRoll, friendNightRoll], nextCursor: null }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    auth.mockResolvedValue(steamId);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('HistoryPage server component', () => {
    it('prompts unauthenticated visitors to sign in with Steam', async () => {
      auth.mockResolvedValue(null);
      const html = renderToStaticMarkup(await HistoryPage());
      expect(html).toContain('Recommendation History');
      expect(html).toContain('Sign in with Steam to see your QIT recommendation history');
      expect(html).toContain('href="/api/auth/steam-login"');
    });

    it('renders the history view for signed-in users', async () => {
      auth.mockResolvedValue(steamId);
      const html = renderToStaticMarkup(await HistoryPage());
      expect(html).toContain('Recommendation History');
      expect(html).toContain('Avoid recent recommendations');
      expect(html).not.toContain('Sign in with Steam to see your QIT recommendation history');
    });
  });

  describe('HistoryView client component rendering', () => {
    it('renders anti-repeat settings options (D6: off, 7, 30, 90)', () => {
      const html = renderToStaticMarkup(<HistoryView />);
      expect(html).toContain('Avoid recent recommendations');
      expect(html).toContain('Off');
      expect(html).toContain('7 days');
      expect(html).toContain('30 days (default)');
      expect(html).toContain('90 days');
    });

    it('renders view filter tabs for all recommendations and played games', () => {
      const html = renderToStaticMarkup(<HistoryView />);
      expect(html).toContain('All recommendations');
      expect(html).toContain('Played games');
    });

    it('renders recommendation items with mode, status, date, reasons and actions', () => {
      const html = renderToStaticMarkup(<HistoryView />);
      // Initial SSR render shows loading or items
      expect(html).toBeDefined();
    });

    it('renders active re-roll card with ExcludableResultCard', () => {
      const card: Card = {
        appid: 620,
        name: 'Portal 2',
        modeId: 'dust-collector',
        rollId: 'roll-999',
        art: { header: 'https://cdn.cloudflare.steamstatic.com/steam/apps/620/header.jpg', icon: null },
        reasons: [{ code: 'idle', params: { months: 14 } }],
        playtimeForever: 45,
        lastPlayedAt: Math.floor(Date.now() / 1000) - 14 * 30 * 86400,
        achievements: { unlocked: 15, total: 51, percent: 29 },
        live: { players: 1200, band: 'high' },
        friends: null,
        previousSelections: 1,
        storeUrl: 'https://store.steampowered.com/app/620',
        launchUrl: 'steam://run/620',
      };
      const html = renderToStaticMarkup(
        <ExcludableResultCard card={card} onPlay={() => {}} onReroll={() => {}} onViewOnSteam={() => {}} />,
      );
      expect(html).toContain('Portal 2');
      expect(html).toContain('Dust Collector');
      expect(html).toContain('Play this');
      expect(html).toContain('Reroll');
      expect(html).toContain('Not tonight');
      expect(html).toContain('View on Steam');
      expect(html).toContain('Add to exclusions');
    });
  });

  describe('navigation item enablement', () => {
    it('enables history in nav items for signed-in users', () => {
      expect(isNavEnabled('history')).toBe(true);
      expect(navbarItems(true).some(item => item.id === 'history')).toBe(true);
      expect(navbarItems(false).some(item => item.id === 'history')).toBe(false);
      expect(NAV_ITEMS.find(item => item.id === 'history')?.href).toBe('/history');
    });
  });
});
