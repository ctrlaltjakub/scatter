'use client';

import { useEffect } from 'react';
import { getAdapter, resolveBaseUrl } from '@/providers/registry';
import { modelCatalogRequestKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';

/**
 * Restore the capability metadata for the saved secondary-task model after a
 * reload. The catalog is intentionally runtime-only, but free-image discovery
 * needs its vision flag before any model picker has been opened.
 */
export function SecondaryModelCatalogCoordinator() {
  const hydrated = useSettingsStore((state) => state.hydrated);
  const providers = useSettingsStore((state) => state.providers);
  const activeModelRef = useSettingsStore((state) => state.activeModelRef);
  const secondaryModelRef = useSettingsStore((state) => state.secondaryModelRef);
  const useMain = useSettingsStore((state) => state.secondaryUseSameModel);

  const targetRef = useMain ? activeModelRef : secondaryModelRef;
  const provider = targetRef
    ? providers.find((candidate) => candidate.id === targetRef.providerId)
    : undefined;
  const requestKey = provider ? modelCatalogRequestKey(provider) : '';
  const providerId = provider?.id;
  const preset = provider?.preset;
  const apiKey = provider?.apiKey ?? '';
  const baseUrl = provider?.baseUrl;

  // Chats also need vision + tool metadata before the picker has been opened.
  // Reuse the same deduplicated catalog; this is never a model replacement.
  const mainProvider = providers.find((candidate) => candidate.id === activeModelRef?.providerId);
  useEffect(() => {
    if (!hydrated || !mainProvider?.apiKey.trim() || mainProvider.id === providerId || !activeModelRef?.model) return;
    void useModelCatalogStore.getState().refreshCatalog(mainProvider.id, modelCatalogRequestKey(mainProvider),
      () => getAdapter(mainProvider.preset).listModels(mainProvider.apiKey,
        resolveBaseUrl(mainProvider.preset, mainProvider.baseUrl))).catch(() => undefined);
  }, [hydrated, mainProvider, providerId, activeModelRef?.model]);

  useEffect(() => {
    if (!hydrated || !providerId || !preset || !apiKey.trim() || !targetRef?.model) return;
    void useModelCatalogStore.getState().refreshCatalog(
      providerId,
      requestKey,
      () => getAdapter(preset).listModels(
        apiKey,
        resolveBaseUrl(preset, baseUrl),
      ),
    ).catch(() => {
      // The node-side control keeps its explanatory disabled state when a
      // provider is offline. Opening the picker can retry the same request.
    });
  }, [apiKey, baseUrl, hydrated, preset, providerId, requestKey, targetRef?.model]);

  return null;
}
