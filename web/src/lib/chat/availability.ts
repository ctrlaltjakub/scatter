import { resolveCaps } from '@/lib/modelMeta';
import { getActiveProvider } from '@/store/providerSelectors';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { ModelInfo } from '@/providers/types';
import type { ProviderPreset, ScatterNode } from '@/store/types';
import { currentContentType } from '@/lib/nodeContentType';
import { isEditableImageMedia } from '@/lib/imageEditActions';
import { chatParentPending } from './model';

export function chatModelCompatible(preset: ProviderPreset, id: string, info?: ModelInfo): boolean {
  // Picker eligibility also requires hosted search. Existing saved local
  // connections can still chat without search: don't disable their working
  // conversations merely because the settings catalog has become stricter.
  const caps = resolveCaps(preset, id, info);
  return caps.vision === true && caps.tools === true && caps.textOutput !== false;
}
export function chatAvailability(parent?: ScatterNode): { available: boolean; reason: string } {
  const settings = useSettingsStore.getState();
  const provider = getActiveProvider(settings);
  const model = settings.activeModelRef?.model;
  if (!provider?.apiKey.trim() || !model) return { available: false, reason: 'Choose a main model in Settings.' };
  const info = useModelCatalogStore.getState().getModel(provider.id, model);
  const bypass = settings.modelCompatibilityOverrides?.main === true;
  if (!bypass && !info && !useModelCatalogStore.getState().hasCatalog(provider.id)
    && !chatModelCompatible(provider.preset, model)) return {
    available: false, reason: 'Loading main-model capabilities. Your saved model has not been changed.',
  };
  if (!bypass && !chatModelCompatible(provider.preset, model, info)) return {
    available: false, reason: 'Chat needs a main model with vision and tool calling. Choose a compatible model in Settings.',
  };
  if (parent && currentContentType(parent) === 'media'
    && !isEditableImageMedia(parent.versions[parent.currentVersionIndex]?.media)) {
    return { available: false, reason: 'Chat can discuss still images. Videos, GIFs, embeds, and empty media are not supported.' };
  }
  if (chatParentPending(parent)) return { available: false, reason: 'Wait for the displayed parent version to finish generating.' };
  return { available: true, reason: '' };
}
