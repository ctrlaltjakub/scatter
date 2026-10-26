import { configuredPrompt } from '@/lib/configuredPrompt';
import { secondaryOutputTokens } from './generationLimits';
import type { ChatImageInput } from '@/providers/types';
import { getAdapter, resolveBaseUrl } from '@/providers/registry';
import { getActiveProvider, getProviderById } from '@/store/providerSelectors';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import type { ChatMessage } from './promptBuilder';
import { EmbeddedImageText } from './embeddedImageText';
import { checkFinishReason, requireVisibleText } from './generationValidation';

function configuredSecondary() {
  const settings = useSettingsStore.getState();
  const dedicated = !settings.secondaryUseSameModel ? settings.secondaryModelRef : undefined;
  const provider = dedicated
    ? getProviderById(settings, dedicated.providerId)
    : getActiveProvider(settings);
  const model = dedicated?.model ?? settings.activeModelRef?.model;
  if (!provider?.apiKey.trim() || !model?.trim()) return null;
  return { provider, model };
}

export async function secondaryTaskCompletion(options: {
  system: string;
  user: string;
  maxOutputTokens?: number;
  /** Retained for task-call compatibility; truncated output is always rejected. */
  rejectTruncated?: boolean;
  signal?: AbortSignal;
  imageInputs?: ChatImageInput[];
}): Promise<string> {
  const config = configuredSecondary();
  if (!config) throw new Error('Choose a secondary tasks model first.');
  const adapter = getAdapter(config.provider.preset);
  const embeddedImages = new EmbeddedImageText();
  const messages: ChatMessage[] = [
    { role: 'system', content: embeddedImages.protect(options.system) },
    { role: 'user', content: embeddedImages.protect(options.user) },
  ];
  let output = '';
  for await (const chunk of adapter.streamChat(config.provider.apiKey, {
    model: config.model,
    modelInfo: useModelCatalogStore.getState().getModel(config.provider.id, config.model),
    messages,
    maxOutputTokens: secondaryOutputTokens(useSettingsStore.getState(), options.maxOutputTokens ?? 2_000),
    signal: options.signal,
    webSearch: false,
    reasoningEffort: 'low',
    imageInputs: options.imageInputs,
  }, resolveBaseUrl(config.provider.preset, config.provider.baseUrl))) {
    output += chunk.delta;
    checkFinishReason(chunk.finishReason, 'secondary');
    if (chunk.done) break;
  }
  requireVisibleText(output, 'secondary');
  return embeddedImages.restore(output.trim());
}

export async function sourceQueryAlternates(query: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const raw = await secondaryTaskCompletion({
      system: configuredPrompt('sourceQueryAlternates'),
      user: query,
      maxOutputTokens: 350,
      signal,
    });
    const match = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { queries?: unknown };
    return Array.isArray(parsed.queries)
      ? parsed.queries.filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim()).filter(Boolean).slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

export async function transcribeSourceImage(
  dataUrl: string,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  const raw = await secondaryTaskCompletion({
    system: configuredPrompt('sourceTranscription'),
    user: configuredPrompt('sourceTranscriptionTask', { label }),
    maxOutputTokens: 8_000,
    signal,
    imageInputs: [{ id: 'source-page', url: dataUrl, detail: 'high' }],
  });
  return raw === '[NO READABLE TEXT]' ? '' : raw;
}
