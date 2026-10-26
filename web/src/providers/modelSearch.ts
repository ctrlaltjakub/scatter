import type { ProviderPreset, ServerSearch } from '@/store/types';
import type { ModelInfo } from './types';
import { isGeminiTextModel } from './geminiModels';

export function isLocalSearchPreset(preset: ProviderPreset): boolean {
  return preset === 'ollama' || preset === 'lm-studio' || preset === 'custom';
}

export const DEFAULT_LM_STUDIO_SEARCH_TOOL = 'searxng_web_search';
export function allowedSearchTools(config: Extract<ServerSearch, { tools: string[] }>): string[] {
  const tools = [...new Set(config.tools.map(name => name.trim()).filter(Boolean))];
  return tools.length ? tools : config.kind === 'lmstudio-mcp' ? [DEFAULT_LM_STUDIO_SEARCH_TOOL] : [];
}

/** Search credentials do not belong in URLs, settings exports, or query strings. */
export function validSearchEndpoint(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function validServerSearch(config?: ServerSearch): boolean {
  if (config?.kind === 'lmstudio-mcp') return /^[\w.-]{1,128}$/.test(config.server)
    && allowedSearchTools(config).every(name => /^[\w.-]{1,128}$/.test(name));
  if (config?.kind === 'responses-mcp') return validSearchEndpoint(config.url)
    && config.tools.length > 0 && config.tools.every(name => /^[\w.-]{1,128}$/.test(name));
  return config?.kind === 'localai' && config.servers.length > 0
    && config.servers.every(name => /^[\w.-]{1,128}$/.test(name));
}

export function supportsModelSearch(preset: ProviderPreset, model: string, info?: ModelInfo, endpoint?: string,
  serverSearch?: ServerSearch, bypass = false): boolean {
  if (isLocalSearchPreset(preset)) return (serverSearch ? validServerSearch(serverSearch) : validSearchEndpoint(endpoint))
    && (bypass || info?.caps?.tools === true);
  return bypass || supportsHostedSearch(preset, model);
}

/** Pure capability policy shared by the adapters and model-selection UI. */
export function openaiModelSupportsSearch(model: string): boolean {
  return /search/i.test(model)
    || /^gpt-4\.1(?:$|[-.])/i.test(model)
    || /^gpt-(?:[5-9]|\d{2,})(?:$|[-.])/i.test(model)
    || /^o3(?:$|-)/i.test(model)
    || /^o4-mini(?:$|-)/i.test(model);
}

export function supportsHostedSearch(preset: ProviderPreset, model: string): boolean {
  return preset === 'openrouter' || preset === 'anthropic'
    || (preset === 'gemini' && isGeminiTextModel(model))
    || (preset === 'openai' && openaiModelSupportsSearch(model));
}
