'use client';

import { resolveInteractiveModel } from '@/lib/interactiveModel';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';

export function useInteractiveGenerationAvailable(): boolean {
  const providers = useSettingsStore((state) => state.providers);
  const activeModelRef = useSettingsStore((state) => state.activeModelRef);
  const interactiveModelRef = useSettingsStore((state) => state.interactiveModelRef);
  const catalog = useModelCatalogStore((state) => state.catalog);
  return !!resolveInteractiveModel({
    providers,
    activeModelRef,
    interactiveModelRef,
    catalog,
  }).ref;
}
