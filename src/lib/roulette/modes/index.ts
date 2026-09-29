import { MODE_IDS, type Mode, type ModeId } from '../types';
import pureRandom from './pure-random';
import dustCollector from './dust-collector';
import somethingDifferent from './something-different';
import comfortPick from './comfort-pick';
import achievementHunter from './achievement-hunter';
import aliveAndKicking from './alive-and-kicking';
import everyoneOwnsIt from './everyone-owns-it';
import finishSomething from './finish-something';
import rediscovery from './rediscovery';

// One entry per id; the mapped type makes a missing id a compile error.
const MODES: { [K in ModeId]: Mode } = {
  'pure-random': pureRandom,
  'dust-collector': dustCollector,
  'something-different': somethingDifferent,
  'comfort-pick': comfortPick,
  'achievement-hunter': achievementHunter,
  'alive-and-kicking': aliveAndKicking,
  'everyone-owns-it': everyoneOwnsIt,
  'finish-something': finishSomething,
  'rediscovery': rediscovery,
};

export function isModeId(value: unknown): value is ModeId {
  return typeof value === 'string' && (MODE_IDS as readonly string[]).includes(value);
}

export function getMode(id: ModeId): Mode {
  return MODES[id];
}

/** Every registered mode, stubs included, in MODE_IDS order. */
export function listModes(): Mode[] {
  return MODE_IDS.map(id => MODES[id]);
}
