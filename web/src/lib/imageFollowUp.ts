import type { ImageRegion } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { getActiveProvider } from '@/store/providerSelectors';
import { modelSupportsVision } from './modelMeta';
import { isStillImageMedia } from './imageEditActions';
import { normalizedImageRegions } from './imageRegions';
import { spawnFollowUp } from './generate';
import { clearCapturedImageSelection, useImageSelectionStore } from '@/store/useImageSelectionStore';

export function askImageFollowUp(nodeId: string, question: string, regions: readonly ImageRegion[], onSpawn?: () => void): Promise<string> {
  const graph = useGraphStore.getState();
  const node = graph.project?.nodes[nodeId];
  const media = node?.versions[node.currentVersionIndex]?.media;
  if (!node || !isStillImageMedia(media)) throw new Error('This action is available only for still images.');
  if (node.generating) throw new Error('Wait for this image to finish generating first.');
  const settings = useSettingsStore.getState();
  const provider = getActiveProvider(settings);
  const model = settings.activeModelRef?.model;
  if (!provider?.apiKey.trim() || !model) throw new Error('Choose a main AI model in Settings first.');
  const info = useModelCatalogStore.getState().catalog[provider.id]?.find((entry) => entry.id === model);
  if (!settings.modelCompatibilityOverrides?.main && !modelSupportsVision(provider.preset, model, info)) throw new Error('Choose a main model that supports image input to ask about this image.');
  const captured = useImageSelectionStore.getState().selection;
  return spawnFollowUp(nodeId, question, undefined, {
    sourceMedia: structuredClone(media), regions: normalizedImageRegions(regions),
    sourceVersionCreatedAt: node.versions[node.currentVersionIndex]!.createdAt,
  }, () => {
    if (captured?.nodeId === nodeId && captured.projectId === graph.project?.id) clearCapturedImageSelection(captured);
    onSpawn?.();
  });
}
