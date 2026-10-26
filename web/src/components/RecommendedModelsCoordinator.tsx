'use client';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore, modelCatalogRequestKey } from '@/store/useModelCatalogStore';
import { useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { getAdapter, getImageAdapter, resolveBaseUrl } from '@/providers/registry';
import { pendingRecommendedRoles, recommendedModelId, recommendedModelIds, RECOMMENDED_MODELS } from '@/lib/recommendedModels';
import { anyProjectGenerating } from '@/store/bgGen';

export function RecommendedModelsCoordinator() {
  const hydrated = useSettingsStore(s => s.hydrated);
  const preferences = useSettingsStore(s => s.modelRecommendations);
  const providers = useSettingsStore(s => s.providers);
  const onboarding = useSettingsStore(s => s.forceWelcomeA);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!hydrated || onboarding || !preferences) return;
    const pending = pendingRecommendedRoles(useSettingsStore.getState());
    const accounts = providers.map(provider => ({ provider, roles: pending.filter(role =>
      preferences[role].ref?.providerId === provider.id && recommendedModelIds(role, provider.preset).length > 0) }))
      .filter(({ provider, roles }) => provider.apiKey.trim() && roles.length);
    if (!accounts.length) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Catalog checks only: never paid test generations or model downloads.
    void Promise.all(accounts.map(async ({ provider, roles }) => {
      const base = resolveBaseUrl(provider.preset, provider.baseUrl);
      const key = modelCatalogRequestKey(provider);
      const imageAdapter = getImageAdapter(provider.preset);
      const [textResult, imageResult] = await Promise.allSettled([
        roles.some(role => role !== 'image') ? useModelCatalogStore.getState().refreshCatalog(provider.id, key,
          () => getAdapter(provider.preset).listModels(provider.apiKey, base)) : Promise.resolve([]),
        roles.includes('image') && imageAdapter ? useImageModelCatalogStore.getState().refreshCatalog(provider.id, key,
          () => imageAdapter.listModels(provider.apiKey, base)) : Promise.resolve([]),
      ]);
      // A failed refresh must not authorize an update from a stale catalog.
      return { provider, key, roles, text: textResult.status === 'fulfilled' ? textResult.value : [],
        images: imageResult.status === 'fulfilled' ? imageResult.value : [] };
    })).then(results => {
      const apply = () => {
        if (cancelled) return;
        if (anyProjectGenerating()) { retry = setTimeout(apply, 1500); return; }
        const updated: string[] = [];
        const skipped: string[] = [];
        for (const result of results) {
          const current = useSettingsStore.getState();
          const account = current.providers.find(p => p.id === result.provider.id);
          if (!account || modelCatalogRequestKey(account) !== result.key
            || account.webSearchEndpoint !== result.provider.webSearchEndpoint
            || JSON.stringify(account.serverSearch) !== JSON.stringify(result.provider.serverSearch)) continue;
          const stillPending = pendingRecommendedRoles(current);
          for (const role of result.roles.filter(role => stillPending.includes(role))) {
            if (!recommendedModelId(role, account, result.text, result.images)) skipped.push(RECOMMENDED_MODELS[role].label.toLowerCase());
          }
          const changed = current.applyRecommendedModels(account.id, false, result);
          updated.push(...changed.map(role => RECOMMENDED_MODELS[role].name));
        }
        if (updated.length || skipped.length) setNotice([
          updated.length ? `Recommended models updated: ${updated.join(', ')}.` : '',
          skipped.length ? `Kept the current ${skipped.join(' and ')}: a recommended replacement could not be verified on its provider.` : '',
          'Review automatic updates in Settings → Models and generation.',
        ].filter(Boolean).join(' '));
      };
      apply();
    }).catch(() => {
      if (!cancelled) setNotice('Automatic model updates could not be checked. Current models were kept. Try again by reopening the app.');
    });
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
  }, [hydrated, preferences, providers, onboarding]);
  return notice ? <div className="model-update-notice" role="status"><span>{notice}</span>
    <button className="icon-btn" aria-label="Dismiss model update notice" onClick={() => setNotice('')}><X size={14} /></button></div> : null;
}
