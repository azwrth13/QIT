// Route registry for every QIT surface. Each surface package flips only its own `enabled` flag when it
// ships; links and buttons pointing at a surface should check `isNavEnabled` so they stay hidden until then.

export type NavItemId =
  | 'home' | 'library' | 'backlog' | 'friends' | 'friend-night' | 'compare' | 'lobby' | 'daily' | 'history'
  | 'hunt' | 'rare-challenge' | 'profile' | 'privacy';

export interface NavItem {
  id: NavItemId;
  href: string;
  label: string;
  enabled: boolean;
  /** Shown only to signed-in visitors. */
  requiresAuth: boolean;
  /** False for surfaces reached from other pages (for example /compare/<steamid>) rather than the navbar. */
  inNavbar: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', href: '/', label: 'Home', enabled: true, requiresAuth: false, inNavbar: true },
  { id: 'library', href: '/library', label: 'Library', enabled: true, requiresAuth: false, inNavbar: true },
  { id: 'daily', href: '/daily', label: 'Daily', enabled: true, requiresAuth: true, inNavbar: true },
  { id: 'backlog', href: '/backlog', label: 'Backlog', enabled: true, requiresAuth: true, inNavbar: true },
  { id: 'friends', href: '/friends', label: 'Friends', enabled: false, requiresAuth: true, inNavbar: true },
  { id: 'friend-night', href: '/friend-night', label: 'Friend Night', enabled: false, requiresAuth: true, inNavbar: true },
  { id: 'compare', href: '/compare', label: 'Compare', enabled: true, requiresAuth: true, inNavbar: false },
  { id: 'lobby', href: '/lobby', label: 'Lobby', enabled: false, requiresAuth: true, inNavbar: true },
  { id: 'hunt', href: '/hunt', label: 'Achievement Hunt', enabled: false, requiresAuth: true, inNavbar: true },
  { id: 'rare-challenge', href: '/rare-challenge', label: 'Rare Challenge', enabled: false, requiresAuth: true, inNavbar: true },
  { id: 'history', href: '/history', label: 'History', enabled: false, requiresAuth: true, inNavbar: true },
  { id: 'profile', href: '/profile', label: 'Stats', enabled: true, requiresAuth: true, inNavbar: true },
  { id: 'privacy', href: '/privacy', label: 'Privacy', enabled: false, requiresAuth: false, inNavbar: false },
];

export function isNavEnabled(id: NavItemId): boolean {
  return NAV_ITEMS.some(item => item.id === id && item.enabled);
}

export function navbarItems(signedIn: boolean): NavItem[] {
  return NAV_ITEMS.filter(item => item.enabled && item.inNavbar && (signedIn || !item.requiresAuth));
}
