import type { ImageModelInfo, ModelInfo } from './types';
import { normalizeProviderError } from './errors';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const geminiBase = (base?: string) => (base || GEMINI_BASE).replace(/\/+$/, '')
  .replace(/^(https:\/\/generativelanguage\.googleapis\.com\/v1(?:beta)?)\/openai$/, '$1');

export interface GeminiModel {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

export async function listGeminiModels(key: string, base?: string): Promise<GeminiModel[]> {
  const models = new Map<string, GeminiModel>();
  const seen = new Set<string>();
  let page = '';
  do {
    if (seen.has(page)) throw new Error('Google returned a repeated model catalog page. Try refreshing the catalog.');
    seen.add(page);
    const params = new URLSearchParams({ pageSize: '1000' });
    if (page) params.set('pageToken', page);
    const response = await fetch(`${geminiBase(base)}/models?${params}`, {
      headers: { 'x-goog-api-key': key }, credentials: 'omit', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw normalizeProviderError(response.status, await response.text(), response.headers.get('retry-after'));
    const body = await response.json() as { models?: GeminiModel[]; nextPageToken?: string };
    for (const model of body.models ?? []) if (typeof model.name === 'string') models.set(model.name, model);
    page = body.nextPageToken ?? '';
  } while (page);
  return [...models.values()];
}

/** Google reports limits and thinking, but not a complete capability matrix.
 * Infer only general-purpose documented families; unknown models remain
 * accessible through the existing compatibility-filter override. */
export function isGeminiTextModel(id: string): boolean {
  return /^gemini-(?:[2-9][\d.]*-(?:flash|pro|argon)(?:-|$)|(?:flash(?:-lite)?|pro)-latest$)/i.test(id)
    && !/(?:image|audio|tts|live|transcribe|computer-use|robotics|omni)/i.test(id);
}

export function geminiReasoning(id: string, thinking = true): ModelInfo['reasoning'] {
  if (!thinking) return { supportedEfforts: [] };
  const levels: NonNullable<ModelInfo['reasoning']>['supportedEfforts'] = /^gemini-3-pro(?:-|$)/.test(id)
    ? ['low', 'high'] : /^gemini-3(?:\.1|\.5|\.6)?-flash(?:-|$)/.test(id)
      ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high'];
  return { supportedEfforts: levels, defaultEffort: 'medium', mandatory: true, mode: 'adaptive' };
}

export function parseGeminiModel(model: GeminiModel): ModelInfo {
  const id = model.name.replace(/^models\//, '');
  const general = isGeminiTextModel(id);
  const nonText = /(?:image|tts|audio|live|omni|lyria|veo|embedding|transcribe|antigravity|deep-research)/i.test(id);
  return { id, name: model.displayName, contextLength: model.inputTokenLimit, maxOutputTokens: model.outputTokenLimit,
    caps: { reasoning: model.thinking === true, ...(general ? { vision: true, tools: true, json: true, textOutput: true }
      : nonText ? { textOutput: false } : {}) },
    reasoning: general ? geminiReasoning(id, model.thinking === true) : { supportedEfforts: [] },
  };
}

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export function parseGeminiImageModel(model: GeminiModel): ImageModelInfo | null {
  const id = model.name.replace(/^models\//, '');
  if (!/^(?:gemini-(?:[\d.]+-(?:flash(?:-lite)?|pro)-image|nano-banana)|nano-banana-pro)(?:-|$)/i.test(id)) return null;
  const old = id.startsWith('gemini-2.5-');
  const lite = id.includes('flash-lite-image');
  return { id, name: model.displayName, supportsImageEditing: true,
    maxInputImages: old ? 3 : 14, aspectRatios: ASPECT_RATIOS,
    resolutions: old ? undefined : lite ? ['1K'] : ['1K', '2K', '4K'],
    outputFormats: ['jpeg'],
  };
}
