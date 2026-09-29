import { getSteamClient, type SteamClient } from './client';
import { steamKeylessUrl, steamStoreUrl } from './urls';

/** Store metadata: batched `IStoreBrowseService/GetItems` and single-app `appdetails` (both keyless). */

/** 250 ids worked and 300 failed with 414 (the limit is URL length), so 100 leaves a wide margin. */
export const STORE_ITEMS_BATCH = 100;

export type StoreItem = {
  appid: number;
  name: string;
  type: number | null;
  visible: boolean;
  tagids: number[];
  /** Tag weights, present when a tag count is requested. */
  tags: Array<{ tagid: number; weight: number }>;
  categories: { supported_player_categoryids: number[]; feature_categoryids: number[]; controller_categoryids: number[] };
  /** Unix seconds. */
  releaseDate: number | null;
  reviews: { review_count: number; percent_positive: number; review_score: number; review_score_label: string } | null;
  /** `asset_url_format` plus file names, as Steam sends them. */
  assets: Record<string, string | number> | null;
  parentAppid: number | null;
};

type RawStoreItem = {
  id?: number; success?: number; visible?: boolean; name?: string; type?: number;
  tagids?: number[]; tags?: Array<{ tagid?: number; weight?: number }>;
  categories?: Partial<StoreItem['categories']>;
  release?: { steam_release_date?: number };
  reviews?: { summary_filtered?: StoreItem['reviews'] };
  assets?: Record<string, string | number>;
  related_items?: { parent_appid?: number };
};

const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id)) : [];

function toStoreItem(appid: number, item: RawStoreItem): StoreItem {
  return {
    appid,
    name: typeof item.name === 'string' ? item.name : '',
    type: typeof item.type === 'number' ? item.type : null,
    visible: item.visible === true,
    tagids: ids(item.tagids),
    tags: (Array.isArray(item.tags) ? item.tags : []).flatMap(tag =>
      Number.isSafeInteger(tag?.tagid) && typeof tag.weight === 'number' ? [{ tagid: tag.tagid as number, weight: tag.weight }] : []),
    categories: {
      supported_player_categoryids: ids(item.categories?.supported_player_categoryids),
      feature_categoryids: ids(item.categories?.feature_categoryids),
      controller_categoryids: ids(item.categories?.controller_categoryids),
    },
    releaseDate: typeof item.release?.steam_release_date === 'number' ? item.release.steam_release_date : null,
    reviews: item.reviews?.summary_filtered ?? null,
    assets: item.assets && typeof item.assets === 'object' ? item.assets : null,
    parentAppid: typeof item.related_items?.parent_appid === 'number' ? item.related_items.parent_appid : null,
  };
}

export type StoreItemsOptions = { language?: string; countryCode?: string; tagCount?: number; assets?: boolean; reviews?: boolean };

/**
 * Metadata for many apps, `STORE_ITEMS_BATCH` per call. Every requested appid is in the result;
 * null means Steam had nothing (`success: 15` for hidden or delisted apps), i.e. unknown metadata.
 * Items are matched by `id`, because hidden apps come back with `appid: 0`.
 */
export async function getStoreItems(appids: readonly number[], options: StoreItemsOptions = {}, client: SteamClient = getSteamClient()): Promise<Map<number, StoreItem | null>> {
  const { language = 'english', countryCode = 'US', tagCount = 20, assets = true, reviews = true } = options;
  const unique = [...new Set(appids)];
  if (unique.some(appid => !Number.isSafeInteger(appid) || appid <= 0)) throw new Error('Invalid app ID');
  const batches: number[][] = [];
  for (let offset = 0; offset < unique.length; offset += STORE_ITEMS_BATCH) batches.push(unique.slice(offset, offset + STORE_ITEMS_BATCH));
  const result = new Map<number, StoreItem | null>(unique.map(appid => [appid, null]));
  await Promise.all(batches.map(async batch => {
    const input = {
      ids: batch.map(appid => ({ appid })),
      context: { language, country_code: countryCode },
      data_request: { include_assets: assets, include_release: true, include_tag_count: tagCount, include_reviews: reviews },
    };
    const data = await client.json<{ response?: { store_items?: RawStoreItem[] } }>(
      steamKeylessUrl('/IStoreBrowseService/GetItems/v1/', { input_json: JSON.stringify(input) }));
    for (const item of data?.response?.store_items ?? []) {
      if (typeof item?.id === 'number' && result.has(item.id) && item.success === 1) result.set(item.id, toStoreItem(item.id, item));
    }
  }));
  return result;
}

/**
 * Single-app store details. Only one app per call: Steam answers 400 for several appids unless
 * `filters=price_overview`. Returns null when Steam reports `success: false`.
 */
export async function getAppDetails<T = Record<string, unknown>>(appid: number, options: { filters?: string; countryCode?: string } = {}, client: SteamClient = getSteamClient()): Promise<T | null> {
  if (!Number.isSafeInteger(appid) || appid <= 0) throw new Error('Invalid app ID');
  const params: Record<string, string> = { appids: String(appid), cc: (options.countryCode ?? 'us').toLowerCase() };
  if (options.filters) params.filters = options.filters;
  const data = await client.json<Record<string, { success?: boolean; data?: T }>>(steamStoreUrl('/api/appdetails', params));
  const entry = data?.[String(appid)];
  return entry?.success === true && entry.data ? entry.data : null;
}
