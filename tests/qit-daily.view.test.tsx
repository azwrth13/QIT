import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DailyView } from '../src/components/daily/DailyView';
import { DailyWidgetContent } from '../src/components/daily/DailyWidget';
import { canAct, DEFAULT_DAILY_SETTINGS, parseDailySettings, type DailyResponse, type DailyView as DailyRecord } from '../src/lib/daily/model';
import { RESULT_CARD_FIXTURES } from '../src/components/result-card/fixtures';

const card = RESULT_CARD_FIXTURES[0].card;
const base: DailyRecord = { date: '2026-10-03', tz: 'America/Los_Angeles', settings: DEFAULT_DAILY_SETTINGS, status: 'ready', rerolls: 0,
  selection: { card, seed: 'fixture', selectedAt: Date.parse('2026-10-03T15:00Z'), playtimeAtRoll: 0, poolSize: 3, coverage: { library: 1, achievements: 0.3 } }, previous: [], decidedAt: null };
const render = (daily: DailyRecord, historical = false) => renderToStaticMarkup(<DailyView daily={daily} historical={historical} onAction={() => {}} />);

describe('Daily views and state contract', () => {
  it('shows the stored result with reasons and all available daily actions', () => {
    const html = render(base);
    for (const label of [card.name, 'Why QIT picked it', 'Accept daily game', 'I played it', 'Reroll (3 left)', 'Skip today', 'Some game data is unavailable']) expect(html).toContain(label);
  });
  it('renders empty picks without requiring an enriched card', () => {
    const html = render({ ...base, status: 'empty', selection: { ...base.selection, card: null, coverage: {} } });
    expect(html).toContain('No eligible game'); expect(html).toContain('Review and sync your library'); expect(html).toContain('Reroll (3 left)');
    expect(html).not.toContain('Accept daily game'); expect(html).not.toContain('I played it');
  });
  it('renders a card with all optional enrichment missing', () => {
    const html = render({ ...base, selection: { ...base.selection, card: { ...card, art: { icon: null, header: null }, achievements: null, live: null, friends: null } } });
    expect(html).toContain(card.name); expect(html).toContain('No achievement data'); expect(html).toContain('Why QIT picked it');
  });
  it('accept does not claim streak credit, and reaching the cap hides reroll', () => {
    const html = render({ ...base, status: 'accepted', rerolls: 3 });
    expect(html).toContain('Accepted'); expect(html).toContain('I played it'); expect(html).toContain('0 rerolls remaining');
    expect(html).not.toContain('Accept daily game'); expect(html).not.toContain('Reroll (');
    expect(html).not.toContain('today counts toward your streak');
  });
  it('skip and played are terminal, and history is read-only', () => {
    for (const status of ['skipped', 'played'] as const) {
      const daily = { ...base, status };
      expect(['accept', 'played', 'reroll', 'skip'].every(action => !canAct(daily, action as Parameters<typeof canAct>[1]))).toBe(true);
      const html = render(daily);
      expect(html).not.toContain('Skip today'); expect(html).not.toContain('I played it'); expect(html).not.toContain('Reroll (');
    }
    expect(render({ ...base, status: 'skipped' })).toContain('this pick earns no streak credit');
    expect(render({ ...base, status: 'played' })).toContain('today counts toward your streak');
    expect(render(base, true)).not.toContain('Accept daily game');
  });
  it('preserves earlier picks including an empty reroll', () => {
    const html = render({ ...base, rerolls: 2, previous: [base.selection, { ...base.selection, card: null }] });
    expect(html).toContain('Earlier picks today (2)'); expect(html).toContain('First pick'); expect(html).toContain('No eligible game');
  });
  it('renders widget loading, error, empty, and saved states', () => {
    expect(renderToStaticMarkup(<DailyWidgetContent data={null} loading error="" />)).toContain('Choosing your daily game');
    expect(renderToStaticMarkup(<DailyWidgetContent data={null} loading={false} error="Try again" />)).toContain('Try again');
    const data: DailyResponse = { today: base, settings: base.settings, tz: base.tz, now: base.selection.selectedAt, nextDayAt: base.selection.selectedAt + 3600000 };
    expect(renderToStaticMarkup(<DailyWidgetContent data={data} loading={false} error="" />)).toContain(card.name);
    expect(renderToStaticMarkup(<DailyWidgetContent data={{ ...data, today: { ...base, selection: { ...base.selection, card: null } } }} loading={false} error="" />)).toContain('No eligible game today');
  });
  it('validates the preference contract and all supported anti-repeat options', () => {
    for (const antiRepeatDays of [0, 7, 30, 90]) expect(parseDailySettings({ mode: 'pure-random', antiRepeatDays })).toEqual({ mode: 'pure-random', antiRepeatDays });
    for (const value of [null, {}, { mode: 'fake', antiRepeatDays: 30 }, { mode: 'backlog-mix', antiRepeatDays: 14 }, { ...DEFAULT_DAILY_SETTINGS, user: 'other' }]) expect(parseDailySettings(value)).toBeNull();
  });
});
