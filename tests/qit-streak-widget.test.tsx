import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StreakWidget } from '../src/components/progression/StreakWidget';
import type { Progression } from '../src/lib/history/progression';

const empty: Progression = { current: 0, longest: 0, lastDay: null, gamesDiscovered: 0, backlogGamesStarted: 0, challengesCompleted: 0, rareAchievementsCompleted: 0 };
const active: Progression = { current: 3, longest: 7, lastDay: '2026-10-01', gamesDiscovered: 12, backlogGamesStarted: 4, challengesCompleted: 6, rareAchievementsCompleted: 2 };

const stats = (progression: Progression) => {
  const html = renderToStaticMarkup(<StreakWidget progression={progression} />);
  return Object.fromEntries([...html.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, label, value]) => [label, value]));
};

describe('StreakWidget', () => {
  it('renders an empty state that invites a first qualifying action', () => {
    expect(stats(empty)).toMatchObject({ 'Current streak': '0 days', 'Longest streak': '0 days', 'Games discovered': '0' });
    expect(renderToStaticMarkup(<StreakWidget progression={empty} />)).toContain('starts your first streak');
  });

  it('renders every personal counter for an active streak', () => {
    expect(stats(active)).toEqual({
      'Current streak': '3 days', 'Longest streak': '7 days', 'Games discovered': '12',
      'Backlog games started': '4', 'Challenges completed': '6', 'Rare achievements completed': '2',
    });
    expect(renderToStaticMarkup(<StreakWidget progression={active} />)).not.toContain('starts your first streak');
  });

  it('renders a lapsed streak with the longest streak retained and singular day labels', () => {
    expect(stats({ ...active, current: 0, longest: 1 })).toMatchObject({ 'Current streak': '0 days', 'Longest streak': '1 day' });
  });
});
