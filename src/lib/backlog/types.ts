import type { BacklogCategory } from '../library/backlog';
import type { Card } from '../roulette/types';

export type { BacklogCategory };

export const BACKLOG_CATEGORY_IDS: readonly BacklogCategory[] = [
  'never-played',
  'barely-played',
  'not-played-in-a-long-time',
  'started-but-abandoned',
  'low-completion',
  'high-completion-but-unfinished',
] as const;

export function isBacklogCategory(value: unknown): value is BacklogCategory {
  return typeof value === 'string' && (BACKLOG_CATEGORY_IDS as readonly string[]).includes(value);
}

export interface BacklogGameItem {
  appid: number;
  name: string;
  playtimeForever: number;
  lastPlayedAt: number | null;
  achievements: { unlocked: number; total: number; percent: number } | null;
  iconHash: string | null;
}

export type BacklogCategoryStatus = 'ready' | 'scan_required' | 'playtime_hidden';

export interface BacklogCategorySummary {
  id: BacklogCategory;
  label: string;
  description: string;
  count: number;
  games: BacklogGameItem[];
  status: BacklogCategoryStatus;
  unscannedCount?: number;
}

export interface BacklogOverview {
  categories: Record<BacklogCategory, BacklogCategorySummary>;
  playtimeHidden: boolean;
  libraryBuilt: boolean;
  totalGames: number;
  scannedGames: number;
  unscannedGames: number;
}

export interface BacklogSpinRequest {
  category: BacklogCategory;
  exclude?: number[];
  sessionId?: string;
  seed?: string;
}

export interface BacklogSpinResponse {
  card: Card | null;
  poolSize: number;
  category: BacklogCategory;
  seed: string;
}
