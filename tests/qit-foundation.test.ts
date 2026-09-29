import { describe, expect, it } from 'vitest';
import { FILTER_IDS, MODE_IDS, type Candidate, type FilterContext, type ScoreContext } from '../src/lib/roulette/types';
import { THRESHOLDS } from '../src/lib/roulette/thresholds';
import { getMode, isModeId, listModes } from '../src/lib/roulette/modes';
import { getFilter, isFilterId, listFilters } from '../src/lib/roulette/filters';
import { StubNotImplementedError } from '../src/lib/roulette/stubs';
import { NAV_ITEMS, isNavEnabled, navbarItems } from '../src/app/navbar/nav-items';
import { MAX_WITH_IDS, parseWithParam, withHref } from '../src/lib/links/with-param';

const candidate: Candidate = { appid: 620, signals: { library: { name: 'Portal 2', iconHash: null, playtimeForever: 0, playtime2Weeks: null, lastPlayedAt: null } } };
const ctx: ScoreContext & FilterContext = { now: 1_790_000_000, thresholds: THRESHOLDS, scope: { kind: 'library' } };
const id = (n: number) => `7656119800000${String(n).padStart(4, '0')}`;

describe('roulette registries', () => {
  it('resolve all 20 mode and filter ids, with unimplemented ones as stubs', () => {
    expect(MODE_IDS.length + FILTER_IDS.length).toBe(20);
    // Modes whose owning package has replaced the stub; each has its own tests.
    const implementedModes: readonly string[] = ['pure-random'];
    for (const modeId of MODE_IDS) {
      const mode = getMode(modeId);
      expect(mode).toMatchObject({ id: modeId, stub: !implementedModes.includes(modeId) });
      expect(mode.requires).toContain('library');
      if (!mode.stub) continue;
      expect(() => mode.score(candidate, ctx)).toThrow(StubNotImplementedError);
    }
    for (const filterId of FILTER_IDS) {
      const filter = getFilter(filterId);
      expect(filter).toMatchObject({ id: filterId, stub: true });
      expect(filter.requires.length).toBeGreaterThan(0);
      expect(filter.parse({})).toBeNull();
      expect(() => filter.test(candidate, {}, ctx)).toThrow(StubNotImplementedError);
    }
  });

  it('list every id once, in declared order, with the installed filter absent', () => {
    expect(listModes().map(mode => mode.id)).toEqual([...MODE_IDS]);
    expect(listFilters().map(filter => filter.id)).toEqual([...FILTER_IDS]);
    expect(new Set([...MODE_IDS, ...FILTER_IDS]).size).toBe(20);
    expect(FILTER_IDS).not.toContain('installed');
    expect(isFilterId('installed')).toBe(false);
  });

  it('narrow untrusted ids without trusting prototype keys', () => {
    expect(isModeId('dust-collector')).toBe(true);
    expect(isFilterId('co-op')).toBe(true);
    for (const value of ['constructor', 'toString', 'Dust-Collector', '', 1, null, undefined]) {
      expect(isModeId(value)).toBe(false);
      expect(isFilterId(value)).toBe(false);
    }
  });

  it('limit group-only modes to group scopes', () => {
    expect(getMode('everyone-owns-it').scopes).toEqual(['friends', 'pair', 'lobby']);
    expect(getMode('pure-random').scopes).toEqual(['library', 'friends', 'pair', 'lobby', 'appids']);
  });
});

describe('thresholds', () => {
  it('ship the plan defaults and cannot be mutated', () => {
    expect(THRESHOLDS).toMatchObject({
      barelyPlayedMinutes: 120, notRecentlyPlayedDays: 90, recentRotationDays: 30, longIdleDays: 365,
      rediscoveryMinMinutes: 600, rediscoveryIdleDays: 180, comfortMinMinutes: 1200, closeToCompletePercent: 80,
      manyRemainingLocked: 25, rareTiersPercent: [25, 10, 5], activeMinPlayers: 100, antiRepeatDays: 30,
      antiRepeatDayOptions: [0, 7, 30, 90], playedDeltaMinutes: 10, samplerGamma: 1.5,
    });
    expect(Object.isFrozen(THRESHOLDS) && Object.isFrozen(THRESHOLDS.rareTiersPercent)).toBe(true);
  });
});

describe('nav items', () => {
  it('keep today\'s navbar until a surface flips its own flag', () => {
    expect(navbarItems(false).map(item => item.href)).toEqual(['/', '/library']);
    expect(navbarItems(true).map(item => item.href)).toEqual(['/', '/library']);
    expect(NAV_ITEMS.filter(item => item.enabled).map(item => item.id)).toEqual(['home', 'library']);
    expect(isNavEnabled('library')).toBe(true);
    expect(isNavEnabled('friend-night')).toBe(false);
  });

  it('have unique ids and hrefs', () => {
    expect(new Set(NAV_ITEMS.map(item => item.id)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map(item => item.href)).size).toBe(NAV_ITEMS.length);
  });
});

describe('with param', () => {
  it('parses comma lists and repeated params, dropping invalid and duplicate ids', () => {
    expect(parseWithParam(`${id(1)},${id(2)}`)).toEqual([id(1), id(2)]);
    expect(parseWithParam([`${id(1)}`, ` ${id(2)} ,${id(1)}`])).toEqual([id(1), id(2)]);
    expect(parseWithParam(`123,${id(3)},abc,,${id(4)}x`)).toEqual([id(3)]);
    expect(parseWithParam(null)).toEqual([]);
    expect(parseWithParam(undefined)).toEqual([]);
    expect(parseWithParam('')).toEqual([]);
  });

  it(`caps a selection at ${MAX_WITH_IDS} ids`, () => {
    const ids = Array.from({ length: MAX_WITH_IDS + 4 }, (_, n) => id(n));
    expect(parseWithParam(ids.join(','))).toEqual(ids.slice(0, MAX_WITH_IDS));
  });

  it('builds readable links that round-trip through URLSearchParams', () => {
    const href = withHref('/friend-night', [id(1), id(2), 'bad', id(1)]);
    expect(href).toBe(`/friend-night?with=${id(1)},${id(2)}`);
    expect(parseWithParam(new URL(href, 'https://qit.test').searchParams.get('with'))).toEqual([id(1), id(2)]);
    expect(withHref(`/compare/${id(9)}?tab=shared#top`, [id(1)])).toBe(`/compare/${id(9)}?tab=shared&with=${id(1)}#top`);
    expect(withHref(`/friend-night?with=${id(1)}`, [])).toBe('/friend-night');
  });
});
