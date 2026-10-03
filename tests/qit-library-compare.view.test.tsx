import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompareClient from '../src/app/compare/[steamid]/CompareClient';
import ComparePickerClient from '../src/app/compare/ComparePickerClient';
import ComparePage from '../src/app/compare/[steamid]/page';
import CompareRootPage from '../src/app/compare/page';
import type { CompareResult } from '../src/lib/compare/types';

const { getSteamId } = vi.hoisted(() => ({
  getSteamId: vi.fn(),
}));

vi.mock('../src/lib/auth', () => ({ getSteamId }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

const me = '76561198000000001';
const friend = '76561198000000002';

const sampleResult: CompareResult = {
  target: {
    steamId: friend,
    personaName: 'BestFriend',
    avatarUrl: 'https://example.com/avatar.jpg',
    profileUrl: `https://steamcommunity.com/profiles/${friend}`,
  },
  user: {
    steamId: me,
    personaName: 'MyAccount',
    avatarUrl: 'https://example.com/me.jpg',
  },
  sharedCount: 2,
  both: [
    {
      appid: 730,
      name: 'Counter-Strike 2',
      iconHash: 'cs2hash',
      group: { members: [] },
      owners: [me, friend],
      playtimeByPlayer: { [me]: 300, [friend]: 600 },
      playedBy: [me, friend],
      neverPlayedBy: [],
      unknownPlaytimeBy: [],
    },
    {
      appid: 440,
      name: 'Team Fortress 2',
      iconHash: 'tf2hash',
      group: { members: [] },
      owners: [me, friend],
      playtimeByPlayer: { [me]: 0, [friend]: 120 },
      playedBy: [friend],
      neverPlayedBy: [me],
      unknownPlaytimeBy: [],
    },
  ],
  onlyMe: [
    {
      appid: 570,
      name: 'Dota 2',
      iconHash: 'dota2hash',
      group: { members: [] },
      owners: [me],
      playtimeByPlayer: { [me]: 1500 },
      playedBy: [me],
      neverPlayedBy: [],
      unknownPlaytimeBy: [],
    },
  ],
  onlyThem: [
    {
      appid: 220,
      name: 'Half-Life 2',
      iconHash: 'hl2hash',
      group: { members: [] },
      owners: [friend],
      playtimeByPlayer: { [friend]: 480 },
      playedBy: [friend],
      neverPlayedBy: [],
      unknownPlaytimeBy: [],
    },
  ],
  neitherRecentlyPlayed: [],
  oneNeverPlayed: [
    {
      appid: 440,
      name: 'Team Fortress 2',
      iconHash: 'tf2hash',
      group: { members: [] },
      owners: [me, friend],
      playtimeByPlayer: { [me]: 0, [friend]: 120 },
      playedBy: [friend],
      neverPlayedBy: [me],
      unknownPlaytimeBy: [],
    },
  ],
  playtimeHidden: { me: false, them: false },
  onlyA: [],
  onlyB: [],
};

describe('ComparePage server component', () => {
  beforeEach(() => {
    getSteamId.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders a sign-in prompt when not authenticated', async () => {
    getSteamId.mockResolvedValue(null);
    const element = await ComparePage({ params: Promise.resolve({ steamid: friend }) });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('Sign in to Compare');
    expect(html).toContain('Sign in with Steam');
  });

  it('renders invalid Steam ID notice for non-numeric or wrong length ID', async () => {
    getSteamId.mockResolvedValue(me);
    const element = await ComparePage({ params: Promise.resolve({ steamid: 'abc' }) });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('Invalid Steam ID');
    expect(html).toContain('The profile &quot;abc&quot; is not a valid 17-digit Steam ID');
  });

  it('renders CompareClient when authenticated and given a valid Steam ID', async () => {
    getSteamId.mockResolvedValue(me);
    // Stub fetch to avoid unhandled rejection during render
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})));
    const element = await ComparePage({ params: Promise.resolve({ steamid: friend }) });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('Comparing Steam libraries...');
  });
});

describe('CompareRootPage server component', () => {
  it('renders sign-in prompt when not authenticated', async () => {
    getSteamId.mockResolvedValue(null);
    const element = await CompareRootPage();
    const html = renderToStaticMarkup(element);
    expect(html).toContain('Sign in to Compare');
    expect(html).toContain('Sign in with Steam');
  });

  it('renders ComparePickerClient when authenticated', async () => {
    getSteamId.mockResolvedValue(me);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})));
    const element = await CompareRootPage();
    const html = renderToStaticMarkup(element);
    expect(html).toContain('Compare Steam Libraries');
    expect(html).toContain('Compare by Profile URL or Steam ID');
  });
});

describe('CompareClient rendering states', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders initial loading state', () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})));
    const html = renderToStaticMarkup(<CompareClient steamid={friend} currentUserSteamId={me} />);
    expect(html).toContain('Comparing Steam libraries...');
  });

  it('renders error state with guidance when comparison fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          code: 'forbidden',
          state: 'private',
          message: 'This friend’s game details are private. Ask them to set Game details to Public in Steam.',
        },
      }),
    }));

    const client = <CompareClient steamid={friend} currentUserSteamId={me} />;
    expect(renderToStaticMarkup(client)).toContain('Comparing Steam libraries...');
  });

  it('renders loaded comparison with games, individual playtime, and stats', () => {
    const html = renderToStaticMarkup(
      <CompareClient steamid={friend} currentUserSteamId={me} initialData={sampleResult} />
    );
    expect(html).toContain('BestFriend');
    expect(html).toContain('MyAccount');
    expect(html).toContain('Counter-Strike 2');
    expect(html).toContain('Team Fortress 2');
    expect(html).toContain('Shared Games');
    expect(html).toContain('Spin the shared games');
    expect(html).toContain('You:');
    expect(html).toContain('Never launched');
    expect(html).toContain('BestFriend:');
    expect(html).toContain('2h');
    expect(html).toContain('Both own');
    expect(html).toContain('You never played');
  });
});

describe('ComparePickerClient component', () => {
  it('renders lookup form and empty friends placeholder', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ friends: [], source: 'friends' }),
    }));
    const html = renderToStaticMarkup(<ComparePickerClient currentSteamId={me} />);
    expect(html).toContain('Compare by Profile URL or Steam ID');
    expect(html).toContain('Steam ID (17 digits), profile URL, or custom vanity URL');
    expect(html).toContain('Your Friends');
  });
});
