import { create } from 'zustand';
import type { ImageModelInfo, ImagePriceLine } from '@/providers/types';
import { compareCaseInsensitive } from './providerSelectors';

export const IMAGE_MODEL_CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const IMAGE_PRICING_MAX_CONCURRENCY = 4;

export function imagePricingKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

interface ImageCatalogState {
  catalog: Record<string, ImageModelInfo[]>;
  fetchedAt: Record<string, number>;
  requestKeys: Record<string, string>;
  pricing: Record<string, ImagePriceLine[]>;
  pricingFetchedAt: Record<string, number>;
  pricingRequestKeys: Record<string, string>;
  setCatalog: (providerId: string, models: ImageModelInfo[], fetchedAt?: number) => void;
  setPricing: (providerId: string, modelId: string, lines: ImagePriceLine[], fetchedAt?: number) => void;
  refreshCatalog: (
    providerId: string,
    requestKey: string,
    fetcher: () => Promise<ImageModelInfo[]>,
    options?: { force?: boolean; maxAgeMs?: number },
  ) => Promise<ImageModelInfo[]>;
  refreshPricing: (
    providerId: string,
    modelId: string,
    requestKey: string,
    fetcher: () => Promise<ImagePriceLine[]>,
    options?: { force?: boolean; maxAgeMs?: number },
  ) => Promise<ImagePriceLine[]>;
  clear: () => void;
}

const inFlight = new Map<string, Promise<ImageModelInfo[]>>();
const latestRequestKey = new Map<string, string>();
const pricingInFlight = new Map<string, Promise<ImagePriceLine[]>>();
const latestPricingRequestKey = new Map<string, string>();
const pricingQueue: Array<() => void> = [];
let activePricingRequests = 0;
let pricingEpoch = 0;
const sorted = (models: ImageModelInfo[]) =>
  [...models].sort((a, b) => compareCaseInsensitive(a.id, b.id));

function drainPricingQueue(): void {
  while (activePricingRequests < IMAGE_PRICING_MAX_CONCURRENCY && pricingQueue.length) {
    activePricingRequests += 1;
    pricingQueue.shift()!();
  }
}

function enqueuePricing(fetcher: () => Promise<ImagePriceLine[]>): Promise<ImagePriceLine[]> {
  return new Promise<ImagePriceLine[]>((resolve, reject) => {
    pricingQueue.push(() => {
      let result: Promise<ImagePriceLine[]>;
      try { result = Promise.resolve(fetcher()); }
      catch (error) { result = Promise.reject(error); }
      void result.then(resolve, reject).finally(() => {
        activePricingRequests -= 1;
        drainPricingQueue();
      });
    });
    drainPricingQueue();
  });
}

export const useImageModelCatalogStore = create<ImageCatalogState>((set, get) => ({
  catalog: {},
  fetchedAt: {},
  requestKeys: {},
  pricing: {},
  pricingFetchedAt: {},
  pricingRequestKeys: {},
  setCatalog: (providerId, models, fetchedAt = Date.now()) => set((state) => ({
    catalog: { ...state.catalog, [providerId]: sorted(models) },
    fetchedAt: { ...state.fetchedAt, [providerId]: fetchedAt },
  })),
  setPricing: (providerId, modelId, lines, fetchedAt = Date.now()) => {
    const key = imagePricingKey(providerId, modelId);
    set((state) => ({
      pricing: { ...state.pricing, [key]: lines },
      pricingFetchedAt: { ...state.pricingFetchedAt, [key]: fetchedAt },
    }));
  },
  refreshCatalog: (providerId, requestKey, fetcher, options = {}) => {
    const fetchedAt = get().fetchedAt[providerId];
    const maxAge = options.maxAgeMs ?? IMAGE_MODEL_CATALOG_MAX_AGE_MS;
    if (!options.force && get().requestKeys[providerId] === requestKey
      && fetchedAt && Date.now() - fetchedAt < maxAge) {
      return Promise.resolve(get().catalog[providerId] ?? []);
    }
    const flightKey = `${providerId}\0${requestKey}`;
    const existing = inFlight.get(flightKey);
    if (existing) return existing;
    latestRequestKey.set(providerId, requestKey);
    let fetched: Promise<ImageModelInfo[]>;
    try { fetched = Promise.resolve(fetcher()); }
    catch (error) { fetched = Promise.reject(error); }
    const request = fetched.then((models) => {
      const ordered = sorted(models);
      if (latestRequestKey.get(providerId) === requestKey) {
        get().setCatalog(providerId, ordered);
        set((state) => ({ requestKeys: { ...state.requestKeys, [providerId]: requestKey } }));
      }
      return ordered;
    }).finally(() => {
      if (inFlight.get(flightKey) === request) inFlight.delete(flightKey);
    });
    inFlight.set(flightKey, request);
    return request;
  },
  refreshPricing: (providerId, modelId, requestKey, fetcher, options = {}) => {
    const key = imagePricingKey(providerId, modelId);
    const fetchedAt = get().pricingFetchedAt[key];
    const maxAge = options.maxAgeMs ?? IMAGE_MODEL_CATALOG_MAX_AGE_MS;
    if (!options.force && get().pricingRequestKeys[key] === requestKey
      && fetchedAt && Date.now() - fetchedAt < maxAge) {
      return Promise.resolve(get().pricing[key] ?? []);
    }
    const flightKey = `${key}\0${requestKey}`;
    const existing = pricingInFlight.get(flightKey);
    if (existing) return existing;
    const epoch = pricingEpoch;
    latestPricingRequestKey.set(key, requestKey);
    const request = enqueuePricing(fetcher).then((lines) => {
      if (epoch === pricingEpoch && latestPricingRequestKey.get(key) === requestKey) {
        get().setPricing(providerId, modelId, lines);
        set((state) => ({
          pricingRequestKeys: { ...state.pricingRequestKeys, [key]: requestKey },
        }));
      }
      return lines;
    }).finally(() => {
      if (pricingInFlight.get(flightKey) === request) pricingInFlight.delete(flightKey);
    });
    pricingInFlight.set(flightKey, request);
    return request;
  },
  clear: () => {
    inFlight.clear();
    latestRequestKey.clear();
    pricingInFlight.clear();
    latestPricingRequestKey.clear();
    pricingEpoch += 1;
    set({
      catalog: {}, fetchedAt: {}, requestKeys: {},
      pricing: {}, pricingFetchedAt: {}, pricingRequestKeys: {},
    });
  },
}));
