import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResultCard, type ResultCardProps } from '../src/components/result-card/ResultCard';
import { FIXTURE_NOW, RESULT_CARD_FIXTURES } from '../src/components/result-card/fixtures';
import { bandLabel, formatLastPlayed, formatPlaytime, formatPreviousSelections, liveSummary } from '../src/components/result-card/format';
import { reason, renderReason } from '../src/lib/roulette/reasons';
import type { Card } from '../src/lib/roulette/types';

const fixture = (id: string): Card => {
  const found = RESULT_CARD_FIXTURES.find(f => f.id === id);
  if (!found) throw new Error(`No fixture ${id}`);
  return found.card;
};
const noop = () => {};
const allHandlers = { onPlay: noop, onReroll: noop, onNotTonight: noop, onViewOnSteam: noop, onExclude: noop };
const html = (card: Card, props: Partial<ResultCardProps> = {}) => renderToStaticMarkup(<ResultCard card={card} now={FIXTURE_NOW} {...props} />);
// React escapes apostrophes in text; compare against the rendered form.
const escaped = (text: string) => text.replace(/'/g, '&#x27;');

describe('result card formatting', () => {
  it('formats playtime, keeping never launched distinct', () => {
    expect([0, 25, 60, 75, 599, 3847].map(formatPlaytime)).toEqual(['Never launched', '25m', '1h', '1h 15m', '9h 59m', '64h']);
  });

  it('formats last played with unknown distinct from never', () => {
    expect(formatLastPlayed(0, 0, FIXTURE_NOW)).toBe('Never');
    expect(formatLastPlayed(null, 0, FIXTURE_NOW)).toBe('Never');
    expect(formatLastPlayed(null, 90, FIXTURE_NOW)).toBe('Unknown');
    expect(formatLastPlayed(FIXTURE_NOW - 3600, 90, FIXTURE_NOW)).toBe('Today');
    expect(formatLastPlayed(FIXTURE_NOW - 86_400, 90, FIXTURE_NOW)).toBe('Yesterday');
    expect(formatLastPlayed(FIXTURE_NOW - 8 * 86_400, 90, FIXTURE_NOW)).toBe('8 days ago');
    expect(formatLastPlayed(FIXTURE_NOW - 30 * 86_400, 90, FIXTURE_NOW)).toBe('1 month ago');
    expect(formatLastPlayed(FIXTURE_NOW - 26 * 30 * 86_400, 90, FIXTURE_NOW)).toBe('2 years ago');
    // A clock skewed behind the data never shows a negative age.
    expect(formatLastPlayed(FIXTURE_NOW + 500, 90, FIXTURE_NOW)).toBe('Today');
  });

  it('agrees with the idle months the modes put in reasons', () => {
    const months = 14;
    expect(formatLastPlayed(FIXTURE_NOW - months * 30 * 86_400, 90, FIXTURE_NOW)).toBe('14 months ago');
    expect(renderReason(reason('idle', { months }))).toContain('14 months');
  });

  it('formats previous selections', () => {
    expect([0, 1, 12].map(formatPreviousSelections)).toEqual(['First time QIT picked it', 'QIT picked it once before', 'QIT picked it 12 times before']);
  });

  it('shows no badge without a player counter and names only high and low bands', () => {
    expect(liveSummary(null)).toBeNull();
    expect(liveSummary({ players: null, band: null })).toBeNull();
    expect(liveSummary({ players: 0, band: 'low' })).toEqual({ players: '0 playing now', band: 'low', label: 'Low activity' });
    expect(liveSummary({ players: 61_250, band: 'high' })?.players).toBe('61,250 playing now');
    expect([bandLabel('high'), bandLabel('mid'), bandLabel('low'), bandLabel(null)]).toEqual(['High activity', null, 'Low activity', null]);
  });
});

describe('ResultCard', () => {
  it('renders every fixture', () => {
    for (const { card, busyAction } of RESULT_CARD_FIXTURES) expect(() => html(card, { ...allHandlers, busyAction })).not.toThrow();
  });

  it('shows the top three reasons through the shared renderer, in order', () => {
    const card = fixture('full');
    const markup = html(card);
    const shown = card.reasons.slice(0, 3).map(renderReason);
    let last = -1;
    for (const text of shown) {
      const at = markup.indexOf(escaped(text));
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    expect(markup).not.toContain(escaped(renderReason(card.reasons[3])));
    expect(markup).toContain('Why QIT picked it');
  });

  it('labels the card with the game name and shows the mode', () => {
    const markup = html(fixture('full'));
    const [, titleId] = markup.match(/<article aria-labelledby="([^"]+)"/) ?? [];
    expect(markup).toContain(`<h2 id="${titleId}"`);
    expect(markup).toContain('Deep Rock Galactic</h2>');
    expect(markup).toContain('Rediscovery');
  });

  it('uses header art, falls back to the icon, then to a placeholder', () => {
    expect(html(fixture('full'))).toContain('src="https://cdn.cloudflare.steamstatic.com/steam/apps/548430/header.jpg"');
    const icon = html(fixture('missing-art'));
    expect(icon).toContain('src="https://media.steampowered.com/steamcommunity/public/images/apps/620/');
    expect(icon).not.toContain('header.jpg');
    const none = html(fixture('no-art'));
    expect(none).toContain('No artwork');
    expect(none).not.toContain('<img');
  });

  it('marks art and avatars decorative because the names are visible text', () => {
    for (const img of html(fixture('full')).match(/<img [^>]*>/g) ?? []) expect(img).toContain('alt=""');
  });

  it('shows playtime, last played and achievements, with unknown achievement data distinct from zero', () => {
    const full = html(fixture('full'));
    expect(full).toContain('64h');
    expect(full).toContain('14 months ago</time>');
    expect(full).toContain('62%');
    expect(full).toContain('31 of 50 unlocked');
    expect(html(fixture('missing-art'))).toContain('0%</strong> · 0 of 51 unlocked');
    expect(html(fixture('no-achievements'))).toContain('No achievement data');
    expect(html(fixture('busy-reroll'))).toContain('Unknown');
  });

  it('never shows a player badge without a counter', () => {
    const markup = html(fixture('no-player-counter'));
    expect(markup).toContain('No live player count');
    expect(markup).not.toContain('playing now');
  });

  it('shows the activity band only for high and low', () => {
    expect(html(fixture('activity-high'))).toContain('High activity');
    expect(html(fixture('activity-low'))).toContain('Low activity');
    const mid = html(fixture('activity-none'));
    expect(mid).toContain('3,120 playing now');
    expect(mid).not.toMatch(/(High|Low) activity/);
  });

  it('leads with player activity in multiplayer modes and keeps it in the stats otherwise', () => {
    const multiplayer = html(fixture('activity-high'));
    expect(multiplayer.indexOf('61,250 playing now')).toBeLessThan(multiplayer.indexOf('Why QIT picked it'));
    expect(multiplayer).not.toContain('Players now');
    const solo = html(fixture('full'));
    expect(solo.indexOf('8,412 playing now')).toBeGreaterThan(solo.indexOf('Why QIT picked it'));
    expect(solo).toContain('Players now');
  });

  it('shows friends who own it and who have played it, and hides the section for solo picks', () => {
    const markup = html(fixture('friends-present'));
    expect(markup).toContain('aria-label="Friends"');
    expect(markup).toMatch(/Own it <span[^>]*>\(4\)/);
    expect(markup).toMatch(/Have played it <span[^>]*>\(2\)/);
    expect(markup).toMatch(/Never played it <span[^>]*>\(2\)/);
    expect(markup).toContain('Sam the Destroyer');
    expect(html(fixture('friends-absent'))).not.toContain('aria-label="Friends"');
  });

  it('shows previous QIT selections', () => {
    expect(html(fixture('many-selections'))).toContain('QIT picked it 12 times before');
    expect(html(fixture('friends-absent'))).toContain('First time QIT picked it');
  });

  it('shows only the actions that have handlers', () => {
    const card = fixture('full');
    const labels = ['Play this', 'Reroll', 'Not tonight', 'View on Steam', 'Add to exclusions'];
    const all = html(card, allHandlers);
    for (const label of labels) expect(all).toContain(label);
    const partial = html(card, { onPlay: noop, onViewOnSteam: noop });
    expect(['Play this', 'View on Steam'].every(label => partial.includes(label))).toBe(true);
    expect(['Reroll', 'Not tonight', 'Add to exclusions'].some(label => partial.includes(label))).toBe(false);
    const none = html(card);
    expect(none).not.toContain('Result actions');
    expect(labels.some(label => none.includes(label))).toBe(false);
  });

  it('launches through Steam and opens the store in a new tab', () => {
    const markup = html(fixture('full'), allHandlers);
    expect(markup).toContain('href="steam://run/548430"');
    expect(markup).toMatch(/href="https:\/\/store\.steampowered\.com\/app\/548430" target="_blank" rel="noopener noreferrer"/);
    expect(markup).toContain('(opens in a new tab)');
  });

  it('disables every action while one is busy', () => {
    const markup = html(fixture('busy-reroll'), { ...allHandlers, busyAction: 'reroll' });
    expect(markup.match(/<button [^>]*disabled=""/g)).toHaveLength(3);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Rerolling…');
    expect(markup).not.toContain('href="steam://run/440"');
    expect(markup.match(/aria-disabled="true"/g)).toHaveLength(2);
  });
});
