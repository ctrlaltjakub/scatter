import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, TextModelEndpoint } from '@/providers/types';
import {
  MODEL_CATALOG_MAX_AGE_MS,
  TEXT_ENDPOINT_CATALOG_MAX_AGE_MS,
  TEXT_ENDPOINT_MAX_CONCURRENCY,
  textEndpointKey,
  useModelCatalogStore,
} from './useModelCatalogStore';

const model = (id: string): ModelInfo => ({ id });

beforeEach(() => {
  useModelCatalogStore.getState().clear();
  vi.useRealTimers();
});

describe('runtime model catalog freshness', () => {
  it('refreshes a fresh catalog after the provider connection changes', async () => {
    await useModelCatalogStore.getState().refreshCatalog('p', 'key-one', async () => [model('old')]);
    const changed = vi.fn(async () => [model('new-account-model')]);
    await useModelCatalogStore.getState().refreshCatalog('p', 'key-two', changed);
    expect(changed).toHaveBeenCalledOnce();
    expect(useModelCatalogStore.getState().catalog.p).toEqual([model('new-account-model')]);
  });
  it('treats metadata as fresh for six hours, then refreshes it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    useModelCatalogStore.getState().setCatalog('p', [model('old')]);
    const fetcher = vi.fn(async () => [model('new')]);

    vi.setSystemTime(1_000 + MODEL_CATALOG_MAX_AGE_MS - 1);
    await useModelCatalogStore.getState().refreshCatalog('p', 'config-a', fetcher);
    expect(fetcher).not.toHaveBeenCalled();

    vi.setSystemTime(1_000 + MODEL_CATALOG_MAX_AGE_MS + 1);
    await useModelCatalogStore.getState().refreshCatalog('p', 'config-a', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(useModelCatalogStore.getState().catalog.p).toEqual([model('new')]);
  });

  it('deduplicates concurrent requests for the same provider configuration', async () => {
    let resolve!: (models: ModelInfo[]) => void;
    const fetcher = vi.fn(() => new Promise<ModelInfo[]>((r) => { resolve = r; }));
    const first = useModelCatalogStore.getState().refreshCatalog('p', 'same', fetcher, { force: true });
    const second = useModelCatalogStore.getState().refreshCatalog('p', 'same', fetcher, { force: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve([model('one')]);
    await Promise.all([first, second]);
    expect(useModelCatalogStore.getState().catalog.p).toEqual([model('one')]);
  });

  it('starts a forced refresh for changed provider settings and ignores the older late response', async () => {
    let resolveA!: (models: ModelInfo[]) => void;
    let resolveB!: (models: ModelInfo[]) => void;
    const a = vi.fn(() => new Promise<ModelInfo[]>((r) => { resolveA = r; }));
    const b = vi.fn(() => new Promise<ModelInfo[]>((r) => { resolveB = r; }));
    const first = useModelCatalogStore.getState().refreshCatalog('p', 'config-a', a, { force: true });
    const second = useModelCatalogStore.getState().refreshCatalog('p', 'config-b', b, { force: true });
    resolveB([model('new-config')]);
    await second;
    resolveA([model('old-config')]);
    await first;
    expect(useModelCatalogStore.getState().catalog.p).toEqual([model('new-config')]);
  });

  it('deduplicates route metadata and refreshes recent latency after five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const endpoints: TextModelEndpoint[] = [{ providerName: 'Fast', tag: 'fast', latencyP50Ms: 100 }];
    const fetcher = vi.fn(async () => endpoints);
    const store = useModelCatalogStore.getState();
    await Promise.all([
      store.refreshEndpoints('p', 'm', 'config', fetcher),
      store.refreshEndpoints('p', 'm', 'config', fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(useModelCatalogStore.getState().endpoints[textEndpointKey('p', 'm')]).toEqual(endpoints);

    vi.setSystemTime(2_000 + TEXT_ENDPOINT_CATALOG_MAX_AGE_MS - 1);
    await store.refreshEndpoints('p', 'm', 'config', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.setSystemTime(2_000 + TEXT_ENDPOINT_CATALOG_MAX_AGE_MS + 1);
    await store.refreshEndpoints('p', 'm', 'config', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('limits route-metadata requests to four at a time', async () => {
    const resolvers: Array<(endpoints: TextModelEndpoint[]) => void> = [];
    let active = 0;
    let peak = 0;
    const fetcher = vi.fn(() => new Promise<TextModelEndpoint[]>((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      resolvers.push((value) => { active -= 1; resolve(value); });
    }));
    const requests = Array.from({ length: 6 }, (_, index) =>
      useModelCatalogStore.getState().refreshEndpoints('p', `m${index}`, 'config', fetcher));
    expect(fetcher).toHaveBeenCalledTimes(TEXT_ENDPOINT_MAX_CONCURRENCY);
    for (const resolve of resolvers.splice(0)) resolve([]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6));
    for (const resolve of resolvers.splice(0)) resolve([]);
    await Promise.all(requests);
    expect(peak).toBe(TEXT_ENDPOINT_MAX_CONCURRENCY);
  });
});
