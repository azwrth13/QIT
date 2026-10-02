import { describe, expect, it } from 'vitest';
import { calculateProgression, type ProgressionEvent } from '../src/lib/history/progression';

const event = (id: string, at: string, type = 'played', extra: Partial<ProgressionEvent> = {}): ProgressionEvent => ({ id, type, at: Date.parse(at), ...extra });

describe('personal progression', () => {
  it('ignores picking, accepting, skipping, and issuing challenges', () => {
    const events = ['roll', 'accept', 'daily_accept', 'daily_skip', 'challenge_issue', 'challenge_accept', 'constructor'].map(type => event(type, '2026-01-01T12:00Z', type));
    expect(calculateProgression(events, 'UTC', Date.parse('2026-01-01T13:00Z'))).toMatchObject({ current: 0, longest: 0 });
  });

  it('handles out-of-order and duplicate events, distinct games, and rare challenge completion', () => {
    const a = event('a', '2026-01-01T12:00Z', 'played', { appid: 10, meta: { playtimeAtRoll: 0 } });
    const b = event('b', '2026-01-02T12:00Z', 'challenge_complete', { refId: 'c1', meta: { kind: 'rare' } });
    const c = event('c', '2026-01-02T13:00Z', 'played', { appid: 10, meta: { playtimeAtRoll: 0 } });
    expect(calculateProgression([b, a, a, c, b], 'UTC', Date.parse('2026-01-02T14:00Z'))).toEqual({
      current: 2, longest: 2, lastDay: '2026-01-02', gamesDiscovered: 1, backlogGamesStarted: 1, challengesCompleted: 1, rareAchievementsCompleted: 1,
    });
  });

  it('counts future-package play kinds but never future timestamps', () => {
    const events = [event('a', '2026-01-01T12:00Z', 'daily_played'), event('b', '2026-01-02T12:00Z', 'friend_night_played'), event('c', '2026-01-03T12:00Z', 'rare_challenge_complete')];
    expect(calculateProgression(events, 'UTC', Date.parse('2026-01-02T14:00Z'))).toMatchObject({ current: 2, longest: 2, challengesCompleted: 0 });
  });

});
