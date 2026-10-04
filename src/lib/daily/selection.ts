import type { RollInput } from '../history/rolls';
import { createRng } from '../roulette/sampler';
import { getMode } from '../roulette/modes';
import { orderReasons } from '../roulette/reasons';
import { runSpin, type PipelineDeps } from '../roulette/pipeline';
import { parseSpinRequest } from '../roulette/request';
import { sourcedFamilies } from '../roulette/pipeline';
import type { Mode, ModeId } from '../roulette/types';
import type { DailySelection, DailySettings } from './model';

const MIX: readonly ModeId[] = ['dust-collector', 'rediscovery', 'finish-something', 'something-different'];

/** A weighted mix of the shipped backlog modes, using their own eligibility, scores and explanation reasons. */
function backlogMix(seed: string, selected: Map<number, ModeId>): Mode {
  const modes = MIX.map(getMode);
  return {
    ...getMode('dust-collector'),
    emits: [],
    requires: [...new Set(modes.flatMap(mode => mode.requires))],
    score(candidate, ctx) {
      const scores = modes.map(mode => ({ mode, score: mode.score(candidate, ctx) })).filter(({ score }) => score.eligible && score.weight > 0);
      const weight = scores.reduce((sum, entry) => sum + entry.score.weight, 0);
      if (!weight) return { eligible: false, weight: 0, reasons: [] };
      let draw = createRng(`${seed}:${candidate.appid}`)() * weight;
      const chosen = scores.find(entry => (draw -= entry.score.weight) < 0) ?? scores[scores.length - 1];
      selected.set(candidate.appid, chosen.mode.id);
      return { ...chosen.score, reasons: orderReasons(chosen.score.reasons, chosen.mode.emits), weight: weight / modes.length };
    },
  };
}

/** No independent roll is written: the daily owner commits the snapshot and daily event atomically. */
export async function drawDaily(steamId: string, date: string, index: number, settings: DailySettings,
  exclude: number[], now: number, deps: PipelineDeps): Promise<DailySelection> {
  const seed = `${steamId}:${date}:${settings.mode}:${index}`;
  const selected = new Map<number, ModeId>();
  const parsed = parseSpinRequest({ mode: settings.mode === 'backlog-mix' ? 'dust-collector' : settings.mode,
    filters: [{ id: 'exclude-rolled', params: { days: settings.antiRepeatDays } }], exclude, seed,
  }, 'spin', sourcedFamilies(deps));
  if (!parsed.ok) throw new Error(parsed.error);
  if (settings.mode === 'backlog-mix') parsed.request.mode = backlogMix(seed, selected);
  let input: RollInput | null = null;
  const result = await runSpin(steamId, parsed.request, { ...deps, now: () => now,
    recordRoll: async (_id, roll) => { input = roll; return 'daily'; },
  });
  const card = result.card ? { ...result.card, rollId: null,
    modeId: selected.get(result.card.appid) ?? result.card.modeId } : null;
  return { card, seed, poolSize: result.poolSize, coverage: result.coverage,
    playtimeAtRoll: input ? (input as RollInput).playtimeAtRoll : null, selectedAt: now };
}
