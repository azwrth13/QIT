import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getSteamId: auth }));

import BacklogPage from '../src/app/backlog/page';
import BacklogView, { fetchBacklogOverview } from '../src/app/backlog/BacklogView';
import type { BacklogOverview } from '../src/lib/backlog/types';
import type { Card } from '../src/lib/roulette/types';

const mockOverview: BacklogOverview = {
  totalGames: 5,
  scannedGames: 3,
  unscannedGames: 2,
  playtimeHidden: false,
  libraryBuilt: true,
  categories: {
    'never-played': {
      id: 'never-played',
      label: 'Never played',
      description: 'Games in your library you have never launched.',
      count: 2,
      status: 'ready',
      games: [
        {
          appid: 10,
          name: 'Counter-Strike',
          playtimeForever: 0,
          lastPlayedAt: null,
          achievements: null,
          iconHash: 'hash10',
        },
        {
          appid: 20,
          name: 'Team Fortress Classic',
          playtimeForever: 0,
          lastPlayedAt: null,
          achievements: null,
          iconHash: 'hash20',
        },
      ],
    },
    'barely-played': {
      id: 'barely-played',
      label: 'Barely played',
      description: 'Games with under 2 hours of playtime.',
      count: 1,
      status: 'ready',
      games: [
        {
          appid: 30,
          name: 'Day of Defeat',
          playtimeForever: 45,
          lastPlayedAt: 1780000000,
          achievements: null,
          iconHash: 'hash30',
        },
      ],
    },
    'not-played-in-a-long-time': {
      id: 'not-played-in-a-long-time',
      label: 'Not played in a long time',
      description: 'Games you haven\'t played in over 90 days.',
      count: 1,
      status: 'ready',
      games: [],
    },
    'started-but-abandoned': {
      id: 'started-but-abandoned',
      label: 'Started but abandoned',
      description: 'Games played between 30 minutes and 10 hours, left untouched.',
      count: 0,
      status: 'ready',
      games: [],
    },
    'low-completion': {
      id: 'low-completion',
      label: 'Low achievement completion',
      description: 'Games where you have unlocked under 60% of achievements.',
      count: 1,
      status: 'ready',
      games: [
        {
          appid: 400,
          name: 'Portal',
          playtimeForever: 300,
          lastPlayedAt: 1780000000,
          achievements: { unlocked: 3, total: 15, percent: 20 },
          iconHash: 'hash400',
        },
      ],
      unscannedCount: 2,
    },
    'high-completion-but-unfinished': {
      id: 'high-completion-but-unfinished',
      label: 'High achievement completion',
      description: 'Games where you have unlocked 80% or more of achievements.',
      count: 0,
      status: 'scan_required',
      games: [],
      unscannedCount: 2,
    },
  },
};

const mockCard: Card = {
  appid: 10,
  name: 'Counter-Strike',
  modeId: 'dust-collector',
  rollId: 'roll_456',
  art: { header: null, icon: null },
  reasons: [{ code: 'never_launched', params: {} }],
  playtimeForever: 0,
  lastPlayedAt: null,
  achievements: null,
  live: null,
  friends: null,
  previousSelections: 0,
  storeUrl: 'https://store.steampowered.com/app/10',
  launchUrl: 'steam://run/10',
};

describe('BacklogPage server component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders sign-in prompt when visitor is unauthenticated', async () => {
    auth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await BacklogPage());
    expect(html).toContain('Backlog Discovery');
    expect(html).toContain('Sign in with Steam to explore your backlog');
    expect(html).toContain('href="/api/auth/steam-login"');
  });

  it('renders BacklogView when visitor is authenticated', async () => {
    auth.mockResolvedValue('76561198000000001');
    const html = renderToStaticMarkup(await BacklogPage());
    expect(html).toContain('Backlog Discovery');
    expect(html).not.toContain('Sign in with Steam to explore your backlog');
  });
});

describe('fetchBacklogOverview client function', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns parsed backlog overview from a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(mockOverview), { status: 200 })));
    await expect(fetchBacklogOverview()).resolves.toEqual(mockOverview);
  });

  it('throws message from error envelope when response fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'unavailable', message: 'Your backlog is unavailable right now' } }),
            { status: 502 },
          ),
      ),
    );
    await expect(fetchBacklogOverview()).rejects.toThrow('Your backlog is unavailable right now');
  });

  it('uses friendly error message when response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })));
    await expect(fetchBacklogOverview()).rejects.toThrow('Unable to load backlog data');
  });
});

describe('BacklogView component rendering states', () => {
  it('renders loading state when initialLoading is true', () => {
    const html = renderToStaticMarkup(<BacklogView initialLoading={true} initialOverview={null} />);
    expect(html).toContain('Loading your backlog...');
  });

  it('renders error state with retry button when initialError is set', () => {
    const html = renderToStaticMarkup(
      <BacklogView initialLoading={false} initialOverview={null} initialError="Network connection lost" />,
    );
    expect(html).toContain('Failed to load backlog');
    expect(html).toContain('Network connection lost');
    expect(html).toContain('Try again');
  });

  it('renders empty library prompt when totalGames is 0', () => {
    const emptyOverview: BacklogOverview = {
      ...mockOverview,
      totalGames: 0,
      libraryBuilt: false,
    };
    const html = renderToStaticMarkup(
      <BacklogView initialLoading={false} initialOverview={emptyOverview} />,
    );
    expect(html).toContain('Your library is empty');
    expect(html).toContain('Sync your Steam games in your Library first');
    expect(html).toContain('href="/library"');
  });

  it('renders all six category tabs and details of the selected category', () => {
    const html = renderToStaticMarkup(
      <BacklogView initialLoading={false} initialOverview={mockOverview} initialCategory="never-played" />,
    );

    // Tab labels
    expect(html).toContain('Never played');
    expect(html).toContain('Barely played');
    expect(html).toContain('Not played in a long time');
    expect(html).toContain('Started but abandoned');
    expect(html).toContain('Low achievement completion');
    expect(html).toContain('High achievement completion');

    // Tab counts
    expect(html).toContain('2'); // never-played count
    expect(html).toContain('1'); // barely-played count
    expect(html).toContain('Scan'); // scan_required badge for high-completion

    // Active category details
    expect(html).toContain('Games in your library you have never launched.');
    expect(html).toContain('Spin this backlog');

    // Games listed
    expect(html).toContain('Counter-Strike');
    expect(html).toContain('Team Fortress Classic');
    expect(html).toContain('Launch');
    expect(html).toContain('steam://run/10');
  });

  it('renders achievement scan required callout when category status is scan_required', () => {
    const html = renderToStaticMarkup(
      <BacklogView
        initialLoading={false}
        initialOverview={mockOverview}
        initialCategory="high-completion-but-unfinished"
      />
    );
    expect(html).toContain('Achievement scan required');
    expect(html).toContain('Scan your library achievements to unlock this category');
    expect(html).toContain('Scan achievements to unlock');
  });

  it('renders playtime hidden warning when Steam profile hides playtime', () => {
    const hiddenOverview: BacklogOverview = {
      ...mockOverview,
      playtimeHidden: true,
      categories: {
        ...mockOverview.categories,
        'never-played': {
          ...mockOverview.categories['never-played'],
          status: 'playtime_hidden',
          count: 0,
          games: [],
        },
      },
    };
    const html = renderToStaticMarkup(
      <BacklogView initialLoading={false} initialOverview={hiddenOverview} initialCategory="never-played" />,
    );
    expect(html).toContain('Total playtime is private on Steam');
    expect(html).toContain('Your Steam privacy settings hide total playtime');
  });

  it('renders the spun result card when a card is present', () => {
    const html = renderToStaticMarkup(
      <BacklogView
        initialLoading={false}
        initialOverview={mockOverview}
        initialCategory="never-played"
        initialCard={mockCard}
      />,
    );
    expect(html).toContain('Backlog pick');
    expect(html).toContain('Counter-Strike');
    expect(html).toContain('Why QIT picked it');
    expect(html).toContain('Dismiss');
  });
});
