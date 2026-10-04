import { groupReasons } from '../group/reasons';
import { reason } from '../roulette/reasons';
import { runPoolPreview, runSpin, SpinInputError, type PipelineDeps } from '../roulette/pipeline';
import type { ParsedSpinRequest } from '../roulette/request';
import { DEFAULT_DEPS } from '../roulette/service';
import type { GroupMemberSignals } from '../roulette/types';
import { matchesDiscovery, type Discovery } from './model';

/** Reuse strict group resolution; no selected unreadable player is silently dropped. */
export async function friendNight(steamId: string, request: ParsedSpinRequest, action: 'pool' | 'spin', discovery: Discovery, hours: number, deps: PipelineDeps = DEFAULT_DEPS) {
  if (request.scope.kind !== 'friends' || !request.mode) throw new SpinInputError('Select friends and a mode');
  const resolver = deps.resolvers.friends;
  if (!resolver) throw new SpinInputError('Friend Night is unavailable');
  let unavailable: Array<{ steamId: string; state: string }> = [];
  const wrapped: PipelineDeps = { ...deps, resolvers: { ...deps.resolvers, friends: {
    ...resolver,
    async resolve(scope, ctx) {
      const result = await resolver.resolve(scope, ctx);
      unavailable = result.unavailable;
      return { ...result, candidates: result.candidates.filter(c => c.signals.group && matchesDiscovery(c.signals.group, discovery, hours)) };
    },
  } } };
  const mode = request.mode;
  const enriched = { ...request, mode: { ...mode, requires: [...new Set([...mode.requires, 'live' as const])],
    emits: ['friends_all_own', 'friends_never_played', 'active_now', ...mode.emits] as typeof mode.emits,
    score(candidate: Parameters<typeof mode.score>[0], ctx: Parameters<typeof mode.score>[1]) {
      const score = mode.score(candidate, ctx);
      const live = candidate.signals.live;
      return { ...score, reasons: [...groupReasons(candidate.signals.group!),
        ...(live?.players !== null && live?.players !== undefined && !score.reasons.some(r => r.code === 'active_now') ? [reason('active_now', { players: live.players, band: live.band })] : []), ...score.reasons] };
    },
  } };
  // Capture picked members through the card's appid, independently of scoring order.
  const candidates = new Map<number, GroupMemberSignals[]>();
  const baseResolve = wrapped.resolvers.friends!.resolve;
  wrapped.resolvers.friends!.resolve = async (scope, ctx) => {
    const result = await baseResolve(scope, ctx);
    for (const c of result.candidates) candidates.set(c.appid, c.signals.group!.members);
    return result;
  };
  const result = action === 'spin' ? await runSpin(steamId, enriched, wrapped) : { ...await runPoolPreview(steamId, enriched, wrapped), card: null };
  const members = result.card ? candidates.get(result.card.appid) ?? [] : [];
  return { ...result, members, unavailable };
}
