import type { TextAdapter, StreamChatOpts, ChatChunk, ModelPricing, TextModelEndpoint } from './types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { normalizeProviderError } from './errors';
import { listModelsCompat, streamChatCompat } from './openai';
import { effectiveReasoningEffort } from '@/lib/modelReasoning';

type Effort = StreamChatOpts['reasoningEffort'];

/** Web-search path: 'off'/undefined floor at 'low' (fully disabling risks the
 *  grounding hang), else pass the requested effort. */
function effortForSearch(opts: StreamChatOpts): Effort {
  const requested = opts.reasoningEffort && opts.reasoningEffort !== 'off' ? opts.reasoningEffort : 'low';
  return opts.modelInfo
    ? effectiveReasoningEffort('openrouter', opts.model, requested, opts.modelInfo)
    : requested;
}

/*
 * OpenRouter — the device-only path to many providers at once (OpenAI,
 * Anthropic, Google Gemini, and dozens more) with a single key. OpenRouter
 * allows direct browser calls (CORS), so nothing routes through a server we
 * run. Web search uses OpenRouter's model-agnostic hosted server tool and is
 * required when Scatter's search toggle is on.
 */
const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

// Optional identification headers — OpenRouter ranks apps that send these.
// 'HTTP-Referer' is a custom OpenRouter header (not the browser-forbidden
// 'Referer'), so setting it from the browser is allowed.
const ID_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://scatter.local',
  'X-Title': 'Scatter',
};

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse OpenRouter's endpoint catalog without trusting any provider field to
 * exist. Prices arrive per token and are normalized to the per-million values
 * used everywhere else in Scatter. */
export function parseOpenRouterTextEndpoints(json: unknown): TextModelEndpoint[] {
  const endpoints = (json as { data?: { endpoints?: unknown } })?.data?.endpoints;
  if (!Array.isArray(endpoints)) return [];
  const parsed: TextModelEndpoint[] = [];
  for (const raw of endpoints) {
    if (!raw || typeof raw !== 'object') continue;
    const endpoint = raw as Record<string, unknown>;
    const providerName = typeof endpoint.provider_name === 'string' ? endpoint.provider_name : '';
    const tag = typeof endpoint.tag === 'string' ? endpoint.tag : '';
    if (!providerName || !tag) continue;
    const rawPricing = endpoint.pricing && typeof endpoint.pricing === 'object'
      ? endpoint.pricing as Record<string, unknown>
      : undefined;
    const pricing: ModelPricing = {};
    const input = finiteNumber(rawPricing?.prompt);
    const output = finiteNumber(rawPricing?.completion);
    const webSearch = finiteNumber(rawPricing?.web_search);
    if (input !== undefined) pricing.inputPerM = input * 1e6;
    if (output !== undefined) pricing.outputPerM = output * 1e6;
    if (webSearch !== undefined) pricing.webSearchPerCall = webSearch;
    const latency = endpoint.latency_last_30m && typeof endpoint.latency_last_30m === 'object'
      ? finiteNumber((endpoint.latency_last_30m as Record<string, unknown>).p50)
      : undefined;
    parsed.push({
      providerName,
      tag,
      pricing: Object.keys(pricing).length ? pricing : undefined,
      latencyP50Ms: latency,
      status: finiteNumber(endpoint.status),
    });
  }
  return parsed;
}

/** Fetch endpoint-level pricing and recent latency for one OpenRouter model. */
export async function listOpenRouterTextEndpoints(
  apiKey: string,
  model: string,
  baseUrl = DEFAULT_BASE,
): Promise<TextModelEndpoint[]> {
  const encodedModel = model.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${baseUrl}/models/${encodedModel}/endpoints`, {
    headers: { Authorization: `Bearer ${apiKey}`, ...ID_HEADERS },
  });
  if (!response.ok) {
    throw normalizeProviderError(
      response.status,
      await response.text().catch(() => ''),
      response.headers?.get?.('Retry-After'),
    );
  }
  return parseOpenRouterTextEndpoints(await response.json());
}

/** The reasoning body for a given effort. Exclusion hides reasoning text; it
 * does not reduce its cost or its share of the completion token allowance. */
function reasoningBody(opts: StreamChatOpts): Record<string, unknown> {
  // Tool continuations must retain provider reasoning signatures. These blocks
  // stay request-scoped and are never displayed or persisted in chat history.
  if (opts.tools?.length || opts.webSearch) {
    // With web search, exclude:true makes Gemini's grounding hang → 504; an
    // effort avoids it. 'off' can't fully disable here, so floor at 'low'.
    const effort = effortForSearch(opts);
    return effort ? { effort } : {};
  }
  const e = opts.reasoningEffort;
  if (e === 'off') return { enabled: false };
  return { exclude: true, ...(e ? { effort: e } : {}) };
}

function bodyFor(opts: StreamChatOpts): Record<string, unknown> {
  const routing = useSettingsStore.getState().openRouterRouting;
  const body: Record<string, unknown> = {
    ...(opts.modelInfo?.caps?.reasoning === false ? {} : { reasoning: reasoningBody(opts) }),
    // OpenRouter continuously measures time-to-first-token and provider price.
    // Keep this provider-neutral: it chooses the endpoint afresh for every
    // request and retains OpenRouter's normal fallback chain.
    provider: { sort: routing === 'lowest-cost' ? 'price' : 'latency',
      ...(opts.tools?.length ? { require_parameters: true } : {}) },
  };
  if (opts.webSearch) {
    const policy = opts.webSearchPolicy;
    body.tools = [{
      type: 'openrouter:web_search',
      parameters: {
        // Always use the provider-neutral engine. Gemini native grounding has
        // returned a response marked `stop` while its visible text was cut off
        // inside a Google redirect URL. Exa returned complete, standardized
        // annotations in the same live request and behaves consistently across
        // OpenRouter models.
        engine: 'exa',
        max_results: policy?.maxResults ?? 5,
        max_total_results: policy?.maxTotalResults ?? 5,
        max_characters: policy?.maxCharacters ?? 2_000,
      },
    }];
    // One model tool invocation may contain several underlying search queries.
    // Bounding the loop prevents repeated searches from growing context/cost.
    body.max_tool_calls = Math.max(1, policy?.maxToolCalls ?? 1);
    if (policy?.toolChoice === 'auto') {
      // Evidence workflows validate actual search results. Auto works with
      // forced-tool restrictions across providers, reasoning modes and models
      // without maintaining a model-name allowlist or spending on retries.
      body.tool_choice = 'auto';
    } else if (policy?.required) {
      // Server tools are otherwise optional: the model may answer from memory.
      // Both fields are necessary. `tool_choice` guarantees at least one call;
      // `max_tool_calls` prevents that requirement from creating an unbounded
      // tool loop after the first result comes back.
      body.tool_choice = 'required';
    }
  }
  return body;
}

export const openrouterAdapter: TextAdapter = {
  listModels: (apiKey, baseUrl) => listModelsCompat(apiKey, baseUrl ?? DEFAULT_BASE, ID_HEADERS),
  async *streamChat(apiKey, opts, baseUrl): AsyncIterable<ChatChunk> {
    if (opts.modelInfo) opts = { ...opts, reasoningEffort: effectiveReasoningEffort('openrouter', opts.model, opts.reasoningEffort, opts.modelInfo) };
    const base = baseUrl ?? DEFAULT_BASE;
    const wantsOff = !opts.webSearch && opts.reasoningEffort === 'off';
    let yielded = false;
    try {
      for await (const chunk of streamChatCompat(apiKey, opts, base, { headers: ID_HEADERS, body: bodyFor(opts) })) {
        yielded = true;
        yield chunk;
      }
    } catch (e) {
      // Some models (e.g. Gemini 3.x Flash) MANDATE reasoning and answer
      // `reasoning:{enabled:false}` with a 400 "cannot be disabled". That error
      // arrives before any token streams, so we can safely retry once with
      // minimal HIDDEN reasoning — 'Off' then degrades to "as little thinking as
      // this model allows" instead of failing the whole generation.
      if (wantsOff && !yielded && /cannot be disabled|mandatory/i.test((e as Error).message)) {
        const retryBody = bodyFor(opts);
        yield* streamChatCompat(apiKey, opts, base, {
          headers: ID_HEADERS,
          body: { ...retryBody, reasoning: { exclude: true, effort: effortForSearch({ ...opts, reasoningEffort: 'low' }) } },
        });
        return;
      }
      throw e;
    }
  },
  capabilities: { webSearch: true },
};
