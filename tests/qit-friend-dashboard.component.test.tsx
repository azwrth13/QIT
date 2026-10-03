// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FriendCard from '../src/app/friends/FriendCard';
import FriendsPage from '../src/app/friends/page';
import { NAV_ITEMS } from '../src/app/navbar/nav-items';
import { PRIVATE_GAMES_MESSAGE } from '../src/lib/social/dashboard-types';

const id = '76561198000000002';
const friend = { steamId: id, personaName: 'Portal Pal', avatarFull: 'https://avatars.steamstatic.com/test.jpg', avatarMedium: '', profileUrl: '', status: 1 };
const fetchMock = vi.fn();
let root: Root;
let container: HTMLDivElement;
let observers: Array<{ callback: IntersectionObserverCallback; element?: Element; disconnected: boolean }>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  observers = [];
  vi.stubGlobal('IntersectionObserver', class {
    record: typeof observers[number];
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, disconnected: false }; observers.push(this.record); }
    observe(element: Element) { this.record.element = element; }
    disconnect() { this.record.disconnected = true; }
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(node => node.textContent === label)!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}
async function visible(index: number) {
  const observer = observers[index];
  await act(async () => observer.callback([{ isIntersecting: true, target: observer.element! } as IntersectionObserverEntry], {} as IntersectionObserver));
}

describe('friend cards', () => {
  it('fetches shared counts only when a card is visible, and recent games only on expansion', async () => {
    fetchMock.mockImplementation(async (_path, init) => JSON.parse(init.body).kind === 'shared'
      ? ok({ state: 'ok', count: 3 }) : ok({ state: 'ok', games: [{ appid: 620, name: 'Portal 2', playtime_2weeks: 120 }] }));
    await act(async () => root.render(<><FriendCard friend={friend} pinned={false} /><FriendCard friend={{ ...friend, steamId: '76561198000000003' }} pinned={false} /></>));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => observers[0].callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(fetchMock).not.toHaveBeenCalled();
    await visible(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ steamId: id, kind: 'shared', includeGames: false });
    expect(container.textContent).toContain('3 games shared');
    expect(observers[0].disconnected).toBe(true);
    expect(observers[1].disconnected).toBe(false);
    await click('Recently played');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).kind).toBe('recent');
    expect(container.textContent).toContain('Portal 2');
    expect(container.textContent).toContain('2 hours in the last two weeks');
    await click('Recently played'); await click('Recently played');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows a plain private-game explanation and disables discovery actions', async () => {
    fetchMock.mockResolvedValue(ok({ state: 'private', message: PRIVATE_GAMES_MESSAGE }));
    await act(async () => root.render(<FriendCard friend={friend} pinned={false} />));
    await visible(0);
    expect(container.textContent).toContain(PRIVATE_GAMES_MESSAGE);
    expect(container.textContent).not.toContain('0 games shared');
    const actions = [...container.querySelectorAll('button')].filter(node => /Find games|Start a roulette/.test(node.textContent ?? ''));
    expect(actions.every(node => node.disabled)).toBe(true);
  });

  it('retries unavailable counts and supports manual loading without IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    fetchMock.mockResolvedValueOnce(ok({ state: 'error', message: 'Try again.' })).mockResolvedValueOnce(ok({ state: 'ok', count: 0 }));
    await act(async () => root.render(<FriendCard friend={friend} pinned={false} />));
    expect(fetchMock).not.toHaveBeenCalled();
    await click('Load shared count');
    expect(container.textContent).toContain('Try again.');
    await click('Load shared count');
    expect(container.textContent).toContain('0 games shared');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders pinned profiles, unavailable status, and unpin wiring', async () => {
    const unpin = vi.fn();
    await act(async () => root.render(<FriendCard friend={{ ...friend, status: undefined }} pinned onUnpin={unpin} />));
    expect(container.textContent).toContain('Pinned player');
    expect(container.textContent).toContain('Status unavailable');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(friend.avatarFull);
    await click('Unpin'); expect(unpin).toHaveBeenCalledWith(id);
  });

  it('finds shared games via the pair pool and spins via the pair spin API', async () => {
    fetchMock.mockImplementation(async path => path.endsWith('/details')
      ? ok({ state: 'ok', count: 1, games: [{ appid: 620, name: 'Portal 2', friendMinutes: 120 }] })
      : path.endsWith('/pool') ? ok({ preview: { final: 1 } })
        : ok({ card: { name: 'Portal 2', launchUrl: 'steam://run/620', storeUrl: 'https://store.steampowered.com/app/620/' } }));
    await act(async () => root.render(<FriendCard friend={friend} pinned={false} />));
    await click('Find games we both own');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/roulette/pool');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).scope).toEqual({ kind: 'pair', with: id });
    expect(container.textContent).toContain('2 hours played by Portal Pal');
    await click('Start a roulette with this friend');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/roulette/spin');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).scope).toEqual({ kind: 'pair', with: id });
    expect(container.querySelector('a[href="steam://run/620"]')).not.toBeNull();
  });

  it('hides unshipped destinations and preserves selections in enabled Friend Night links', async () => {
    await act(async () => root.render(<FriendCard friend={friend} pinned={false} />));
    expect(container.textContent).not.toContain('Compare libraries');
    expect(container.textContent).not.toContain('Add to Friend Night');
    const compare = NAV_ITEMS.find(item => item.id === 'compare')!;
    const night = NAV_ITEMS.find(item => item.id === 'friend-night')!;
    compare.enabled = night.enabled = true;
    try {
      await act(async () => root.render(<FriendCard friend={friend} pinned={false} selected={['76561198000000004']} />));
      expect(container.querySelector(`a[href="/compare/${id}"]`)).not.toBeNull();
      expect(container.querySelector('a[href="/friend-night?with=76561198000000004,76561198000000002"]')).not.toBeNull();
    } finally { compare.enabled = night.enabled = false; }
  });
});

describe('dashboard page', () => {
  it('mounts only 14 cards and fetches no libraries on list load or paging', async () => {
    fetchMock.mockResolvedValue(ok({ source: 'friends', friends: Array.from({ length: 30 }, (_, i) => ({ ...friend, steamId: `76561198000000${String(i).padStart(3, '0')}` })) }));
    await act(async () => root.render(<FriendsPage />));
    expect(container.querySelectorAll('article')).toHaveLength(14);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await click('Next');
    expect(container.querySelectorAll('article')).toHaveLength(14);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['friends', 'pinned'])('offers pinned-player fallback for private %s lists', async source => {
    fetchMock.mockResolvedValue(ok({ source, friends: source === 'pinned' ? [friend] : [], message: 'Your Steam friends list is private.' }));
    await act(async () => root.render(<FriendsPage />));
    expect(container.textContent).toContain('Pin players instead');
    expect(container.querySelector('#pin-player')).not.toBeNull();
    if (source === 'pinned') expect(container.textContent).toContain('Pinned player');
  });

  it('shows sign-in and does not load details when signed out', async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    await act(async () => root.render(<FriendsPage />));
    expect(container.querySelector('a[href="/api/auth/steam-login"]')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
