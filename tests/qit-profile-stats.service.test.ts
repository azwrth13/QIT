import { beforeEach, describe, expect, it, vi } from 'vitest';
const { stats, index, doc, get } = vi.hoisted(() => ({ stats: vi.fn(), index: vi.fn(), doc: vi.fn(), get: vi.fn() }));
vi.mock('../src/lib/history/stats', () => ({ readStats: stats }));
vi.mock('../src/lib/store/lib-index', () => ({ readLibIndex: index }));
vi.mock('../src/lib/firestore', () => ({ db: { doc } }));
import { readProfileStats } from '../src/lib/profile/read-stats';

const steamId = '76561198000000001';
describe('profile stats service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doc.mockReturnValue({ get });
    get.mockResolvedValue({ get: (field: string) => field === 'flags.playtimeHidden' });
    index.mockResolvedValue({ entries: new Map([[10, { n: 'Game', p: 0 }]]), built: true });
    stats.mockResolvedValue({ counters: {}, progression: { gamesDiscovered: 2 } });
  });
  it('combines only the owner index and existing summary with hidden-playtime protection', async () => {
    expect(await readProfileStats(steamId)).toMatchObject({ totalGames: 1, neverPlayed: null, gamesDiscovered: 2 });
    expect(stats).toHaveBeenCalledWith(steamId);
    expect(index).toHaveBeenCalledWith(steamId);
    expect(doc).toHaveBeenCalledWith(`users/${steamId}`);
  });
  it('does not replace a failed source with a misleading empty profile', async () => {
    index.mockRejectedValue(new Error('store unavailable'));
    await expect(readProfileStats(steamId)).rejects.toThrow('store unavailable');
  });
});
