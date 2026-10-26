import type { ActiveModelRef, Settings } from '@/store/types';
import type { ImageModelInfo, ModelInfo } from '@/providers/types';
import { listSwitchableModels } from '@/store/providerSelectors';
import { mainModelCompatible, modelSupportsTextOutput, secondaryModelCompatible } from './modelMeta';
import { MODEL_ROLES, RECOMMENDED_MODELS, roleRef } from './recommendedModels';
import { mergeLocalCredentials } from '@/sync/preferences';
import { getImageAdapter } from '@/providers/registry';
import { isProviderEnabled, providerDisabledReason } from '@/providers/providerPolicy';

export function restoreMissingCredentials(imported: Settings, local: Settings): Settings {
  const merged = mergeLocalCredentials(imported, local);
  return { ...imported, providers: imported.providers.map((provider, index) => provider.apiKey.trim() ? provider : merged.providers[index]!) };
}

/** Restore never changes model choices just because their credentials are missing. */
export function missingSetupConnections(settings: Settings): string[] {
  const used = [...listSwitchableModels(settings), ...MODEL_ROLES.map(role => roleRef(settings, role))];
  return [...new Set(used.filter((ref): ref is ActiveModelRef => !!ref)
    .filter(ref => !settings.providers.some(p => p.id === ref.providerId && p.apiKey.trim()))
    .map(ref => ref.providerId))];
}

/** Free catalog checks only. Do not probe generation or silently swap saved models. */
export function validateOnboardingModels(settings: Settings, text: Record<string, ModelInfo[]>, images: Record<string, ImageModelInfo[]>): ActiveModelRef {
  const activeProvider = settings.providers.find(p => p.id === settings.activeModelRef?.providerId);
  if (activeProvider && !isProviderEnabled(activeProvider.preset)) {
    throw new Error(`${providerDisabledReason(activeProvider.preset)} Choose another main model.`);
  }
  if (missingSetupConnections(settings).length) {
    throw new Error('Reconnect the providers for your saved models, or remove those choices in Customize models.');
  }
  const mains = listSwitchableModels(settings);
  if (!mains.length) throw new Error('Choose a main model to start exploring.');
  for (const ref of mains) {
    const provider = settings.providers.find(p => p.id === ref.providerId)!;
    const info = text[ref.providerId]?.find(model => model.id === ref.model);
    if (!settings.modelCompatibilityOverrides?.main && (!info || !mainModelCompatible(provider.preset, ref.model, info, provider.webSearchEndpoint, provider.serverSearch))) {
      throw new Error(`The main model ${ref.model} is unavailable or lacks vision, web search, or tool calling. Choose another main model to continue.`);
    }
  }
  for (const role of ['secondary', 'interactive', 'image'] as const) {
    const ref = roleRef(settings, role);
    if (!ref || (role === 'secondary' && settings.secondaryUseSameModel)) continue;
    const provider = settings.providers.find(p => p.id === ref.providerId)!;
    const info = text[ref.providerId]?.find(model => model.id === ref.model);
    const override = settings.modelCompatibilityOverrides?.[role] === true;
    if (!isProviderEnabled(provider.preset)) throw new Error(`${providerDisabledReason(provider.preset)} Choose another ${role} model.`);
    const image = images[ref.providerId]?.find(model => model.id === ref.model);
    const available = role === 'image' ? !!getImageAdapter(provider.preset)?.edit
      && (override || image?.supportsImageEditing === true)
      : override || (!!info && (role === 'secondary' ? secondaryModelCompatible(provider.preset, ref.model, info, provider.webSearchEndpoint, provider.serverSearch)
        : modelSupportsTextOutput(provider.preset, ref.model, info)));
    if (!available) throw new Error(`Your ${RECOMMENDED_MODELS[role].label.toLowerCase()} (${ref.model}) is unavailable or incompatible. Choose another model${role === 'image' ? ', or turn image generation off' : ''}.`);
  }
  const selected = mains.find(ref => ref.providerId === settings.activeModelRef?.providerId && ref.model === settings.activeModelRef.model) ?? mains[0]!;
  return { providerId: selected.providerId, model: selected.model };
}
