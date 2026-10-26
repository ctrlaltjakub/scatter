'use client';

import { useEffect, useMemo, useState } from 'react';
import { configuredImageEditingAvailable } from '@/lib/imageGeneration';
import { getImageAdapter, resolveBaseUrl } from '@/providers/registry';
import { modelCatalogRequestKey } from '@/store/useModelCatalogStore';
import { useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';

export interface ImageEditingCapability {
  available: boolean;
  checking: boolean;
}

/** Refreshes the runtime-only image catalog on demand so editing still works
 * after a page reload even when Settings has not been opened in this session. */
export function useImageEditingCapability(): ImageEditingCapability {
  const ref = useSettingsStore((state) => state.imageModelRef);
  const providers = useSettingsStore((state) => state.providers);
  const allowUnverified = useSettingsStore(state => state.modelCompatibilityOverrides?.image === true);
  const catalog = useImageModelCatalogStore((state) => state.catalog);
  const [checking, setChecking] = useState(false);
  const provider = useMemo(
    () => providers.find((entry) => entry.id === ref?.providerId),
    [providers, ref?.providerId],
  );

  useEffect(() => {
    if (!ref || !provider?.apiKey.trim() || catalog[provider.id]) {
      setChecking(false);
      return;
    }
    const adapter = getImageAdapter(provider.preset);
    if (!adapter) return;
    let cancelled = false;
    setChecking(true);
    void useImageModelCatalogStore.getState().refreshCatalog(
      provider.id,
      modelCatalogRequestKey(provider),
      () => adapter.listModels(provider.apiKey, resolveBaseUrl(provider.preset, provider.baseUrl)),
    ).catch(() => undefined).finally(() => {
      if (!cancelled) setChecking(false);
    });
    return () => { cancelled = true; };
  }, [catalog, provider, ref]);

  return {
    available: configuredImageEditingAvailable(ref, providers, catalog, allowUnverified),
    checking,
  };
}
