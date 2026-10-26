import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageModelInfo, ImagePriceLine } from '@/providers/types';
import {
  IMAGE_MODEL_CATALOG_MAX_AGE_MS,
  IMAGE_PRICING_MAX_CONCURRENCY,
  imagePricingKey,
  useImageModelCatalogStore,
} from './useImageModelCatalogStore';

const model = (id: string): ImageModelInfo => ({ id });

beforeEach(() => {
  useImageModelCatalogStore.getState().clear();
  vi.useRealTimers();
});

describe('image model metadata freshness', () => {
  it('deduplicates concurrent requests and refreshes after six hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let resolve!: (models: ImageModelInfo[]) => void;
    const fetcher = vi.fn(() => new Promise<ImageModelInfo[]>((done) => { resolve = done; }));
    const first = useImageModelCatalogStore.getState().refreshCatalog('p', 'key', fetcher);
    const second = useImageModelCatalogStore.getState().refreshCatalog('p', 'key', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve([model('gpt-image-2')]);
    await Promise.all([first, second]);

    vi.setSystemTime(1_000 + IMAGE_MODEL_CATALOG_MAX_AGE_MS - 1);
    await useImageModelCatalogStore.getState().refreshCatalog('p', 'key', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000 + IMAGE_MODEL_CATALOG_MAX_AGE_MS + 1);
    const freshFetcher = vi.fn(async () => [model('new')]);
    await useImageModelCatalogStore.getState().refreshCatalog('p', 'key', freshFetcher);
    expect(freshFetcher).toHaveBeenCalledTimes(1);
    expect(useImageModelCatalogStore.getState().catalog.p).toEqual([model('new')]);
  });

  it('refreshes immediately when provider credentials change', async () => {
    const fetcher = vi.fn(async () => [model('one')]);
    await useImageModelCatalogStore.getState().refreshCatalog('p', 'old-key', fetcher);
    await useImageModelCatalogStore.getState().refreshCatalog('p', 'new-key', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('deduplicates image-pricing metadata and refreshes it after six hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const lines: ImagePriceLine[] = [{ billable: 'output_image', unit: 'image', costUsd: 0.04 }];
    const fetcher = vi.fn(async () => lines);
    const store = useImageModelCatalogStore.getState();
    await Promise.all([
      store.refreshPricing('p', 'm', 'key', fetcher),
      store.refreshPricing('p', 'm', 'key', fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(useImageModelCatalogStore.getState().pricing[imagePricingKey('p', 'm')]).toEqual(lines);

    vi.setSystemTime(2_000 + IMAGE_MODEL_CATALOG_MAX_AGE_MS - 1);
    await useImageModelCatalogStore.getState().refreshPricing('p', 'm', 'key', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.setSystemTime(2_000 + IMAGE_MODEL_CATALOG_MAX_AGE_MS + 1);
    await useImageModelCatalogStore.getState().refreshPricing('p', 'm', 'key', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('limits image-pricing metadata to four concurrent requests', async () => {
    const resolvers: Array<(lines: ImagePriceLine[]) => void> = [];
    let active = 0;
    let peak = 0;
    const fetcher = vi.fn(() => new Promise<ImagePriceLine[]>((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      resolvers.push((lines) => { active -= 1; resolve(lines); });
    }));
    const requests = Array.from({ length: 6 }, (_, index) =>
      useImageModelCatalogStore.getState().refreshPricing('p', `m${index}`, 'key', fetcher));
    expect(fetcher).toHaveBeenCalledTimes(IMAGE_PRICING_MAX_CONCURRENCY);
    expect(peak).toBe(IMAGE_PRICING_MAX_CONCURRENCY);

    for (const resolve of resolvers.splice(0)) resolve([]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6));
    for (const resolve of resolvers.splice(0)) resolve([]);
    await Promise.all(requests);
    expect(peak).toBe(IMAGE_PRICING_MAX_CONCURRENCY);
  });
});
