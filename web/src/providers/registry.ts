import type { ProviderPreset, ServerSearch } from '@/store/types';
import type { ModelInfo, ProviderPresetInfo, TextAdapter } from './types';
import { openaiAdapter, openaiCompatibleAdapter } from './openai';
import { ollamaAdapter, lmStudioAdapter } from './localModels';
import { supportsModelSearch } from './modelSearch';
import { openrouterAdapter } from './openrouter';
import { anthropicAdapter } from './anthropic';
import { openaiImageAdapter, openrouterImageAdapter } from './images';
import { GEMINI_BASE } from './geminiModels';
import { GEMINI_DISABLED_REASON, isProviderEnabled } from './providerPolicy';

const disabledGeminiAdapter: TextAdapter = {
  capabilities: { webSearch: false },
  listModels: async () => [],
  async *streamChat() { throw new Error(`${GEMINI_DISABLED_REASON} Choose another provider in Settings → Models and generation.`); },
};

/**
 * Registry of all known provider presets. The app is backend-free: every call
 * goes browser → provider directly. OpenAI, Anthropic and OpenRouter support
 * browser CORS; the local presets (Ollama, LM Studio) hit the user's own
 * machine. Direct Google Gemini connections are retained for saved settings
 * compatibility but disabled by provider policy. Web search is available on
 * `openai` (search-capable models), `anthropic`, and `openrouter` (any model).
 * Local/custom connections can use server-managed search or a separate SearXNG service.
 */
const PRESETS: Record<ProviderPreset, ProviderPresetInfo> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (model aggregator)',
    adapter: openrouterAdapter,
    imageAdapter: openrouterImageAdapter,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    needsProxy: false,
    helpText: 'One key, many models (incl. Gemini), web search on any model — openrouter.ai',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    adapter: openaiAdapter,
    imageAdapter: openaiImageAdapter,
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsProxy: false,
    helpText: 'Get a key at platform.openai.com',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    adapter: anthropicAdapter,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    needsProxy: false,
    helpText: 'Get a key at console.anthropic.com',
  },
  gemini: {
    id: 'gemini', label: 'Google Gemini', adapter: disabledGeminiAdapter,
    defaultBaseUrl: GEMINI_BASE, needsProxy: false,
    helpText: GEMINI_DISABLED_REASON,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    adapter: ollamaAdapter,
    defaultBaseUrl: 'http://localhost:11434/v1',
    needsProxy: false,
    helpText: 'Allow the app’s address in OLLAMA_ORIGINS on your Ollama server. If authentication is off, enter any nonempty API key. Vision and tool support are read from the server.',
  },
  'lm-studio': {
    id: 'lm-studio',
    label: 'LM Studio (local)',
    adapter: lmStudioAdapter,
    defaultBaseUrl: 'http://localhost:1234/v1',
    needsProxy: false,
    helpText: 'Enable the local server and CORS in LM Studio. If authentication is off, enter any nonempty API key. Vision and tool support are read from the server.',
  },
  custom: {
    id: 'custom',
    label: 'OpenAI-compatible (custom URL)',
    adapter: openaiCompatibleAdapter,
    needsProxy: false,
    helpText: 'Any provider that exposes the OpenAI Chat Completions API.',
  },
};

export function getPreset(id: ProviderPreset): ProviderPresetInfo {
  return PRESETS[id];
}

/** Whether `id` is a currently-known preset. Used to defend against a stored
 *  settings.json that still names a preset we've since dropped — an unguarded
 *  getAdapter/getPreset on such an id would crash the generation hot path. */
export function isKnownPreset(id: string): id is ProviderPreset {
  return Object.prototype.hasOwnProperty.call(PRESETS, id);
}

export function listPresets(): ProviderPresetInfo[] {
  return Object.values(PRESETS);
}

export function getAdapter(id: ProviderPreset): TextAdapter {
  return PRESETS[id].adapter;
}

export function getImageAdapter(id: ProviderPreset) {
  return PRESETS[id].imageAdapter;
}

/**
 * Resolve the effective base URL for a provider: the user's override if set,
 * else the preset default (which may be undefined, in which case the adapter
 * falls back to its own hardcoded default). All calls go browser → provider
 * directly; there is no server-side relay.
 */
export function resolveBaseUrl(id: ProviderPreset, override?: string): string | undefined {
  if (override) return override;
  return PRESETS[id].defaultBaseUrl;
}

/**
 * Can the given connection+model actually run web search?
 *  - local / compatible: configured search plus confirmed or user-overridden tool calling.
 *  - openai: current Responses web-search model families.
 *  - anthropic / openrouter: any model.
 * Drives the web-search toggle's availability (disabled + translucent when false).
 */
export function modelSupportsWebSearch(id: ProviderPreset, model: string | undefined, info?: ModelInfo, endpoint?: string,
  serverSearch?: ServerSearch, bypass = false): boolean {
  return isProviderEnabled(id) && !!model && supportsModelSearch(id, model, info, endpoint, serverSearch, bypass);
}

/** Short explanation for the disabled search toggle. */
export function webSearchUnavailableHint(id: ProviderPreset): string {
  switch (id) {
    case 'openai':
      return 'This OpenAI model does not expose hosted search — use GPT-4.1, GPT-5 or later, o3, o4-mini, or OpenRouter.';
    case 'gemini':
      return GEMINI_DISABLED_REASON;
    case 'openrouter':
    case 'anthropic':
      return 'Choose a main model to enable web search.';
    default:
      return 'Connect SearXNG in Settings → AI providers and choose a model with confirmed tool calling to enable web search.';
  }
}
