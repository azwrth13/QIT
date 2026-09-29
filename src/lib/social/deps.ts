import { logServerError } from '../steam';
import { getSteamClient, type SteamClient } from '../steam/client';
import { firestoreSocialStore, type SocialStore } from './store';

/** Everything the social functions reach outside for. Production code passes nothing; tests inject fakes. */
export interface SocialDeps {
  store?: SocialStore;
  client?: SteamClient;
  now?: () => number;
}

export interface ResolvedDeps {
  store: SocialStore;
  client: SteamClient;
  now: () => number;
}

export function resolveDeps(deps: SocialDeps = {}): ResolvedDeps {
  return { store: deps.store ?? firestoreSocialStore, client: deps.client ?? getSteamClient(), now: deps.now ?? Date.now };
}

/** Runs a cache read or write that is allowed to fail: the failure is logged (name only) and `fallback` returned. */
export async function bestEffort<T>(context: string, task: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await task();
  } catch (error) {
    logServerError(context, error);
    return fallback;
  }
}
