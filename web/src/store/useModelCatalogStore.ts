import { create } from 'zustand';
import type { ModelInfo, TextModelEndpoint } from '@/providers/types';
import type { ProviderAccount } from './types';
import { compareCaseInsensitive } from './providerSelectors';

export const MODEL_CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Latency moves much faster than ordinary model metadata, so endpoint route
 * estimates are refreshed on a five-minute cadence. */
export const TEXT_ENDPOINT_CATALOG_MAX_AGE_MS = 5 * 60 * 1000;
export const TEXT_ENDPOINT_MAX_CONCURRENCY = 4;

export function textEndpointKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

interface RefreshOptions {
  force?: boolean;
  maxAgeMs?: number;
}

interface ModelCatalogState {
  catalog: Record<string, ModelInfo[]>;
  fetchedAt: Record<string, number>;
  endpoints: Record<string, TextModelEndpoint[]>;
  endpointFetchedAt: Record<string, number>;
  endpointRequestKeys: Record<string, string>;
  setCatalog: (providerId: string, models: ModelInfo[], fetchedAt?: number) => void;
  getModel: (providerId: string, id: string) => ModelInfo | undefined;
  hasCatalog: (providerId: string) => boolean;
  isFresh: (providerId: string, maxAgeMs?: number) => boolean;
  refreshCatalog: (
    providerId: string,
    requestKey: string,
    fetcher: () => Promise<ModelInfo[]>,
    options?: RefreshOptions,
  ) => Promise<ModelInfo[]>;
  refreshEndpoints: (
    providerId: string,
    modelId: string,
    requestKey: string,
    fetcher: () => Promise<TextModelEndpoint[]>,
    options?: RefreshOptions,
  ) => Promise<TextModelEndpoint[]>;
  clear: () => void;
}

const inFlight = new Map<string, Promise<ModelInfo[]>>();
const latestRequestKey = new Map<string, string>();
const endpointInFlight = new Map<string, Promise<TextModelEndpoint[]>>();
const latestEndpointRequestKey = new Map<string, string>();
const endpointQueue: Array<() => void> = [];
let activeEndpointRequests = 0;
let endpointEpoch = 0;

function drainEndpointQueue(): void {
  while (activeEndpointRequests < TEXT_ENDPOINT_MAX_CONCURRENCY && endpointQueue.length) {
    activeEndpointRequests += 1;
    endpointQueue.shift()!();
  }
}

function enqueueEndpointFetch(fetcher: () => Promise<TextModelEndpoint[]>): Promise<TextModelEndpoint[]> {
  return new Promise<TextModelEndpoint[]>((resolve, reject) => {
    endpointQueue.push(() => {
      let result: Promise<TextModelEndpoint[]>;
      try { result = Promise.resolve(fetcher()); }
      catch (error) { result = Promise.reject(error); }
      void result.then(resolve, reject).finally(() => {
        activeEndpointRequests -= 1;
        drainEndpointQueue();
      });
    });
    drainEndpointQueue();
  });
}

/** Non-secret signature: detects preset/key/base-url changes without retaining
 * the API key itself in the in-flight map. */
export function modelCatalogRequestKey(account: Pick<ProviderAccount, 'preset' | 'apiKey' | 'baseUrl'>): string {
  const raw = `${account.preset}\0${account.apiKey}\0${account.baseUrl ?? ''}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${account.preset}:${(hash >>> 0).toString(36)}`;
}

const sorted = (models: ModelInfo[]) =>
  [...models].sort((a, b) => compareCaseInsensitive(a.id, b.id));

export const useModelCatalogStore = create<ModelCatalogState>((set, get) => ({
  catalog: {},
  fetchedAt: {},
  endpoints: {},
  endpointFetchedAt: {},
  endpointRequestKeys: {},
  setCatalog: (providerId, models, at = Date.now()) =>
    set((s) => ({
      catalog: { ...s.catalog, [providerId]: sorted(models) },
      fetchedAt: { ...s.fetchedAt, [providerId]: at },
    })),
  getModel: (providerId, id) => get().catalog[providerId]?.find((m) => m.id === id),
  hasCatalog: (providerId) => (get().catalog[providerId]?.length ?? 0) > 0,
  isFresh: (providerId, maxAgeMs = MODEL_CATALOG_MAX_AGE_MS) => {
    const at = get().fetchedAt[providerId];
    return typeof at === 'number' && Date.now() - at < maxAgeMs;
  },
  refreshCatalog: (providerId, requestKey, fetcher, options = {}) => {
    const previousKey = latestRequestKey.get(providerId);
    if (!options.force && get().isFresh(providerId, options.maxAgeMs)
      && (previousKey === undefined || previousKey === requestKey)) {
      latestRequestKey.set(providerId, requestKey);
      return Promise.resolve(get().catalog[providerId] ?? []);
    }
    const flightKey = `${providerId}\0${requestKey}`;
    const existing = inFlight.get(flightKey);
    if (existing) return existing;

    latestRequestKey.set(providerId, requestKey);
    let fetched: Promise<ModelInfo[]>;
    try {
      fetched = Promise.resolve(fetcher());
    } catch (error) {
      fetched = Promise.reject(error);
    }
    const promise = fetched.then((models) => {
      const ordered = sorted(models);
      if (latestRequestKey.get(providerId) === requestKey) {
        get().setCatalog(providerId, ordered);
      }
      return ordered;
    }).finally(() => {
      if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey);
    });
    inFlight.set(flightKey, promise);
    return promise;
  },
  refreshEndpoints: (providerId, modelId, requestKey, fetcher, options = {}) => {
    const key = textEndpointKey(providerId, modelId);
    const fetchedAt = get().endpointFetchedAt[key];
    const maxAge = options.maxAgeMs ?? TEXT_ENDPOINT_CATALOG_MAX_AGE_MS;
    if (!options.force && get().endpointRequestKeys[key] === requestKey
      && fetchedAt && Date.now() - fetchedAt < maxAge) {
      return Promise.resolve(get().endpoints[key] ?? []);
    }
    const flightKey = `${key}\0${requestKey}`;
    const existing = endpointInFlight.get(flightKey);
    if (existing) return existing;
    const epoch = endpointEpoch;
    latestEndpointRequestKey.set(key, requestKey);
    const request = enqueueEndpointFetch(fetcher).then((endpoints) => {
      if (epoch === endpointEpoch && latestEndpointRequestKey.get(key) === requestKey) {
        set((state) => ({
          endpoints: { ...state.endpoints, [key]: endpoints },
          endpointFetchedAt: { ...state.endpointFetchedAt, [key]: Date.now() },
          endpointRequestKeys: { ...state.endpointRequestKeys, [key]: requestKey },
        }));
      }
      return endpoints;
    }).finally(() => {
      if (endpointInFlight.get(flightKey) === request) endpointInFlight.delete(flightKey);
    });
    endpointInFlight.set(flightKey, request);
    return request;
  },
  clear: () => {
    inFlight.clear();
    latestRequestKey.clear();
    endpointInFlight.clear();
    latestEndpointRequestKey.clear();
    endpointEpoch += 1;
    set({
      catalog: {}, fetchedAt: {}, endpoints: {}, endpointFetchedAt: {}, endpointRequestKeys: {},
    });
  },
}));
