import type { ChatMessage } from '@/lib/promptBuilder';
import type { ProviderPreset, ReasoningEffort, ServerSearch } from '@/store/types';

/** Rough per-model cost, normalized to USD per 1M tokens. Populated from a
 *  provider's model list when it exposes pricing (OpenRouter does); left
 *  undefined for providers whose /models is id-only (OpenAI, Anthropic, local),
 *  in which case the UI simply shows no price. */
export interface ModelPricing {
  inputPerM?: number;        // USD per 1M input (prompt) tokens
  outputPerM?: number;       // USD per 1M output (completion) tokens
  webSearchPerCall?: number; // USD per hosted web-search call, when charged separately
}

/** What a model can do. Parsed from the provider's model list where available
 *  (OpenRouter's `supported_parameters` / `architecture`), else inferred from
 *  the model name (see lib/modelMeta.ts). Web search is intentionally NOT here —
 *  it's a connection-level decision handled by registry.modelSupportsWebSearch. */
export interface ModelCaps {
  reasoning?: boolean;
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  /** False when provider metadata explicitly says the model cannot emit text. */
  textOutput?: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;             // human label, when the provider gives one
  contextLength?: number;    // max context window in tokens
  maxOutputTokens?: number;  // provider-reported completion ceiling, when known
  pricing?: ModelPricing;
  caps?: ModelCaps;
  reasoning?: {
    /** An explicit empty list means the provider does not offer effort selection. */
    supportedEfforts?: ReasoningEffort[];
    defaultEffort?: ReasoningEffort;
    mandatory?: boolean;
    /** Toggle models use off/high internally but are presented as Off/On. */
    mode?: 'adaptive' | 'budget' | 'toggle';
  };
}

/** One OpenRouter text endpoint for a model. Runtime-only metadata lets the UI
 * estimate the price of the endpoint selected by the user's routing mode.
 * The router still makes the authoritative live choice for each request. */
export interface TextModelEndpoint {
  providerName: string;
  tag: string;
  pricing?: ModelPricing;
  /** Recent median time until the first streamed token, in milliseconds. */
  latencyP50Ms?: number;
  /** OpenRouter currently reports 0 for an available endpoint. */
  status?: number;
}

/** Providers may expose their own quality names (for example DALL-E's
 * `standard` / `hd`). Keep this open so the image-model picker can faithfully
 * offer every value reported by the selected provider. */
export type ImageQuality = string;

/** One normalized image-billing line. Providers use different units, and a
 * single model can expose several routed endpoints or resolution tiers. */
export interface ImagePriceLine {
  billable: 'output_image' | 'input_image' | 'input_reference' | string;
  unit: 'image' | 'megapixel' | 'token' | string;
  costUsd: number;
  variant?: string;
  providerRoute?: string;
  quality?: string;
  size?: string;
  resolution?: string;
  source?: 'provider' | 'documented';
}

/** Runtime metadata exposed by an image provider. Every capability is optional:
 * providers differ, and the UI only renders controls the selected model reports. */
export interface ImageModelInfo {
  id: string;
  name?: string;
  qualities?: ImageQuality[];
  sizes?: string[];
  resolutions?: string[];
  aspectRatios?: string[];
  outputFormats?: string[];
  backgrounds?: string[];
  moderationLevels?: string[];
  outputCompressionRange?: { min: number; max: number };
  supportsSeed?: boolean;
  seedRange?: { min: number; max: number };
  /** Edit-only control for preserving details from the input image. */
  inputFidelities?: string[];
  /** True only when the selected endpoint accepts an existing image as input. */
  supportsImageEditing?: boolean;
  /** Maximum image inputs per edit, INCLUDING the original. Unknown is not
   * a guarantee of multi-image support. */
  maxInputImages?: number;
  supportsCustomSize?: boolean;
  maxPromptChars?: number;
  /** Known pricing bundled with model metadata. OpenRouter endpoint pricing is
   * loaded separately and merged at runtime. */
  pricing?: ImagePriceLine[];
}

export interface GenerateImageOpts {
  model: string;
  prompt: string;
  quality?: ImageQuality;
  size?: string;
  resolution?: string;
  aspectRatio?: string;
  outputFormat?: string;
  background?: string;
  outputCompression?: number;
  seed?: number;
  moderation?: string;
  signal?: AbortSignal;
}

export interface EditImageOpts extends GenerateImageOpts {
  image: Blob;
  /** Ordered visual guides, such as the selection mask followed by its close-up. */
  referenceImages?: Blob[];
  inputFidelity?: string;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mime: string;
}

/** Dedicated one-shot image API. Scatter intentionally does not run a text
 * model first: the user's prompt or selected passage goes straight here. */
export interface ImageAdapter {
  listModels(apiKey: string, baseUrl?: string): Promise<ImageModelInfo[]>;
  /** Optional lazy pricing lookup. It must not block the model catalog itself. */
  listPricing?(apiKey: string, model: string, baseUrl?: string): Promise<ImagePriceLine[]>;
  generate(apiKey: string, opts: GenerateImageOpts, baseUrl?: string): Promise<GeneratedImage>;
  /** Catalogs may contain generation-only models, but the settings picker
   * requires this method and confirmed model-level editing support. */
  edit?(apiKey: string, opts: EditImageOpts, baseUrl?: string): Promise<GeneratedImage>;
}

/** One web-search source the model cited. `startIndex`/`endIndex` point into the
 * model's raw content, but providers give those offsets different meanings. */
export interface Citation {
  url: string;
  title?: string;
  /** Provider-supplied source excerpt/highlight, when available. */
  content?: string;
  startIndex?: number;
  endIndex?: number;
  /** `claim` means the range is cited prose and a key belongs after it.
   * `citation-label` means the range describes provider citation UI/text and
   * must never be treated as a claim endpoint unless that label is visibly
   * present and can be replaced. Omitted retains legacy/internal behavior. */
  offsetKind?: 'claim' | 'citation-label';
}

export interface WebSearchActivity {
  /** At least one hosted search request/result was confirmed by the provider. */
  used: boolean;
  /** Provider-reported number of search requests, when exposed. */
  requestCount?: number;
  /** A recoverable search-specific failure embedded in an otherwise usable response. */
  error?: string;
}

export interface ChatChunk {
  delta: string;        // text delta
  done: boolean;
  /** Web-search citations delivered on this chunk (OpenRouter streams them in
   *  `delta.annotations`); accumulated by the caller. */
  citations?: Citation[];
  /** Normalized evidence about hosted web-search activity on this stream. */
  webSearch?: WebSearchActivity;
  /** Google-provided search widget. Render with the answer, never use as model context. */
  googleSearchSuggestions?: string[];
  /** Why generation stopped, when known (OpenAI-style `finish_reason`). 'length'
   *  means the output was truncated at the token cap — callers use this to reject
   *  a cut-off result instead of committing mid-word text. */
  finishReason?: string | null;
  /** Completed custom calls only. Streaming argument fragments are assembled
   * by the adapter and never executed as partial JSON. */
  toolCalls?: TextToolCall[];
  /** Request-scoped native continuation blocks (e.g. signed thinking).
   * Never display, persist in a project, or replay across unrelated answers. */
  providerResponse?: unknown[];
}

export interface TextToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TextToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: ChatImageInput[];
  toolCalls?: TextToolCall[];
  toolCallId?: string;
  toolError?: boolean;
  providerContent?: unknown[];
}

/** A remotely hosted image shown to a text model for visual assessment. `id`
 * is deliberately opaque: callers can associate the answer with an image
 * without leaking filenames, catalogs, captions, or other metadata that could
 * bias what the model thinks it sees. */
export interface ChatImageInput {
  id: string;
  url: string;
  detail?: 'low' | 'auto' | 'high';
}

export interface StreamChatOpts {
  model: string;
  /** Observable stream phases only; never carries or stores private reasoning. */
  onActivity?: (activity: { phase: 'waiting' | 'reasoning' | 'responding' | 'tool'; tool?: string }) => void;
  /** Metadata for this exact connection, not another account with the same model ID. */
  modelInfo?: ModelInfo;
  messages: ChatMessage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
  webSearch?: boolean;  // request hosted web-search if the provider supports it
  /** Explicit per-connection SearXNG configuration; never inferred from a model name. */
  webSearchEndpoint?: string;
  serverSearch?: ServerSearch;
  /** The user explicitly bypassed this role's compatibility filter. Never
   * fabricate capabilities or bypass tool-argument/security validation. */
  allowUnverifiedCapabilities?: boolean;
  /** Internal search bounds used by evidence-sensitive workflows. Ordinary
   * node generation leaves this undefined and retains provider defaults. */
  webSearchPolicy?: {
    required?: boolean;
    /** Portable evidence workflows use auto plus prompt instructions and
     * validate actual search results, rather than forcing a model tool call. */
    toolChoice?: 'auto';
    maxToolCalls?: number;
    maxResults?: number;
    maxTotalResults?: number;
    maxCharacters?: number;
  };
  /** Reasoning-effort hint for reasoning models. The main node generation passes
   *  the user's Settings dial; the chip pass forces 'low' so a reasoning model
   *  (e.g. Gemini) doesn't spend the whole token budget thinking and truncate the
   *  annotated text. 'off' disables reasoning where the provider supports it.
   *  Translated per-provider in each adapter; a no-op where unsupported. */
  reasoningEffort?: ReasoningEffort;
  /** Optional visual inputs appended to the final user turn. Adapters translate
   * these into their provider-native multimodal content blocks. */
  imageInputs?: ChatImageInput[];
  /** Extended turn-aware conversation. Existing one-shot callers retain the
   * ordinary `messages` path without any behavior change. */
  conversation?: ProviderConversationMessage[];
  tools?: TextToolDefinition[];
  /** App-only character limits for serialized arguments, keyed by tool name.
   * Code-writing tools need more space than ordinary chat actions. Never sent
   * to the provider and independent of the model's output-token allowance. */
  toolArgumentLimits?: Readonly<Record<string, number>>;
}

/**
 * A provider-specific adapter. Each adapter knows how to talk to one API shape
 * (OpenAI-compatible, Anthropic Messages, Gemini native, etc.). The optional
 * `baseUrl` lets the same adapter target different endpoints (e.g. the OpenAI
 * adapter can also be used for OpenRouter, Ollama, Groq, etc. by switching base
 * URL).
 */
export interface TextAdapter {
  listModels(apiKey: string, baseUrl?: string): Promise<ModelInfo[]>;
  streamChat(apiKey: string, opts: StreamChatOpts, baseUrl?: string): AsyncIterable<ChatChunk>;
  /** Static capability hints — used by the UI to enable/disable controls. */
  capabilities: {
    webSearch: boolean;       // adapter knows how to route to a hosted web-search tool
  };
}

/**
 * Static info about a provider preset — what adapter handles it, what default
 * base URL to use, whether the preset needs to go through the CORS proxy.
 */
export interface ProviderPresetInfo {
  id: ProviderPreset;
  label: string;            // user-facing label, e.g. "Google Gemini"
  adapter: TextAdapter;
  /** Present only when this provider exposes a browser-callable image API. */
  imageAdapter?: ImageAdapter;
  /** Default base URL used when the user hasn't overridden it. */
  defaultBaseUrl?: string;
  /** Provider blocks direct browser calls (CORS) — usable only if the user
   *  supplies their own proxy `baseUrl`. The app runs no relay of its own. */
  needsProxy: boolean;
  /** Help text shown next to the API key input. */
  helpText?: string;
}
