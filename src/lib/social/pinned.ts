import { isSteamId, parseSteamSearch } from '../steam';
import { getPlayerSummaries, resolveVanityUrl } from '../steam/players';
import { resolveDeps, type SocialDeps } from './deps';
import { toProfile, toSummaryRecord, type FriendProfile } from './friends';

// Pinned players (D11): when the friends list is private, the user adds the players they want to see by profile
// URL, Steam ID or vanity name. The list is `users/{id}/meta/pinned`, written only here. `getFriends` reads it.

export const MAX_PINNED = 50;
/** Longest accepted input, enough for any profile URL. */
export const MAX_PIN_INPUT_LENGTH = 200;

export type PinFailure = 'invalid' | 'not_found' | 'self' | 'limit';
export type PinResult = { ok: true; player: FriendProfile; pinned: string[] } | { ok: false; reason: PinFailure };

/**
 * Pins a player given as a profile URL, a 17-digit Steam ID or a vanity name. Pinning someone twice is a no-op.
 * Steam failures throw (`SteamClientError`); everything the user can fix comes back as a `reason`.
 */
export async function pinPlayer(steamId: string, input: string, socialDeps: SocialDeps = {}): Promise<PinResult> {
  const { store, client } = resolveDeps(socialDeps);
  const parsed = input.length <= MAX_PIN_INPUT_LENGTH ? parseSteamSearch(input) : null;
  if (!parsed) return { ok: false, reason: 'invalid' };
  const targetId = 'steamId' in parsed ? parsed.steamId : await resolveVanityUrl(parsed.vanity, client);
  if (!isSteamId(targetId)) return { ok: false, reason: 'not_found' };
  if (targetId === steamId) return { ok: false, reason: 'self' };
  const summary = (await getPlayerSummaries([targetId], client)).get(targetId);
  if (!summary) return { ok: false, reason: 'not_found' };
  let limited = false;
  const pinned = await store.updatePinned(steamId, ids => {
    if (ids.includes(targetId)) return null;
    if (ids.length >= MAX_PINNED) { limited = true; return null; }
    return [...ids, targetId];
  });
  if (limited) return { ok: false, reason: 'limit' };
  return { ok: true, player: toProfile(targetId, toSummaryRecord(summary)), pinned };
}

/** Removes a pinned player and returns the remaining ids. Removing someone who is not pinned changes nothing. */
export async function unpinPlayer(steamId: string, targetId: string, socialDeps: SocialDeps = {}): Promise<string[]> {
  const { store } = resolveDeps(socialDeps);
  return store.updatePinned(steamId, ids => ids.includes(targetId) ? ids.filter(id => id !== targetId) : null);
}
