'use client';

import { configuredImageModelAvailable } from '@/lib/imageGeneration';
import { useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';

/** Reactive availability gate shared by every AI-image action. An explicit
 * Settings → Image model → None choice therefore disables all entry points in
 * the same render, including controls on already-generated image versions. */
export function useImageGenerationAvailable(): boolean {
  const imageModelRef = useSettingsStore((state) => state.imageModelRef);
  const providers = useSettingsStore((state) => state.providers);
  const allowUnverified = useSettingsStore(state => state.modelCompatibilityOverrides?.image === true);
  const catalog = useImageModelCatalogStore((state) => state.catalog);
  return configuredImageModelAvailable(imageModelRef, providers, catalog, allowUnverified);
}
