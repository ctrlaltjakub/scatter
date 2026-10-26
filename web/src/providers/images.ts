import type {
  EditImageOpts,
  GenerateImageOpts,
  GeneratedImage,
  ImageAdapter,
  ImageModelInfo,
  ImagePriceLine,
  ImageQuality,
} from './types';
import { normalizeProviderError, ProviderError } from './errors';
import { documentedOpenAIImagePricing } from '@/lib/imagePricing';

const OPENAI_BASE = 'https://api.openai.com/v1';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://scatter.local',
  'X-Title': 'Scatter',
};

export function isDedicatedImageModelId(id: string): boolean {
  return /(?:^|\/)(?:gpt-(?:image|[\w.]+-image)|chatgpt-image-latest|gemini-[\d.]+-(?:pro-|flash(?:-lite)?-)?image|dall-?e)(?:$|-)/i.test(id);
}

function isOpenAIGptImageId(id: string): boolean {
  return /^(?:gpt-(?:image|[\w.]+-image)(?:$|-)|chatgpt-image-latest$)/i.test(id);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/^data:[^,]+,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function enumValues(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const values = value.filter((entry): entry is string => typeof entry === 'string');
    return values.length ? values : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const values = (value as { values?: unknown }).values;
  return Array.isArray(values)
    ? values.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}

function rangeValue(value: unknown): { min: number; max: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = value as { min?: unknown; max?: unknown };
  return typeof descriptor.min === 'number' && typeof descriptor.max === 'number'
    ? { min: descriptor.min, max: descriptor.max }
    : undefined;
}

function parameterSupported(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function parseGeneratedImage(json: unknown, fallbackMime = 'image/png'): GeneratedImage {
  const first = (json as { data?: { b64_json?: unknown; media_type?: unknown }[] })?.data?.[0];
  if (!first || typeof first.b64_json !== 'string' || !first.b64_json) {
    throw new ProviderError('The image model returned no image.', { kind: 'server', retryable: true });
  }
  return {
    bytes: decodeBase64(first.b64_json),
    mime: typeof first.media_type === 'string' ? first.media_type : fallbackMime,
  };
}

function mimeForFormat(format: string | undefined): string {
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  if (format === 'svg') return 'image/svg+xml';
  return 'image/png';
}

async function postImage(
  url: string,
  apiKey: string,
  opts: GenerateImageOpts,
  headers?: Record<string, string>,
  bodyExtras?: Record<string, unknown>,
): Promise<GeneratedImage> {
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    n: 1,
  };
  if (!bodyExtras?.response_format) body.output_format = 'png';
  if (opts.quality) body.quality = opts.quality;
  if (opts.size) body.size = opts.size;
  if (opts.resolution) body.resolution = opts.resolution;
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
  if (opts.outputFormat) body.output_format = opts.outputFormat;
  if (opts.background) body.background = opts.background;
  if (opts.outputCompression != null) body.output_compression = opts.outputCompression;
  if (opts.seed != null) body.seed = opts.seed;
  if (opts.moderation) body.moderation = opts.moderation;
  Object.assign(body, bodyExtras);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!response.ok) {
    throw normalizeProviderError(response.status, await response.text().catch(() => ''));
  }
  return parseGeneratedImage(await response.json(), mimeForFormat(opts.outputFormat));
}

const GPT_QUALITIES: ImageQuality[] = ['auto', 'low', 'medium', 'high'];
const GPT_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'];

export function directOpenAIImageModel(id: string): ImageModelInfo | null {
  if (isOpenAIGptImageId(id) && /image-2(?:$|-)/i.test(id)) {
    return {
      id,
      name: /^gpt-image-2(?:$|-)/i.test(id) ? 'GPT Image 2' : undefined,
      qualities: GPT_QUALITIES,
      sizes: [...GPT_SIZES, 'custom'],
      supportsCustomSize: true,
      outputFormats: ['png', 'jpeg', 'webp'],
      backgrounds: ['auto', 'opaque'],
      moderationLevels: ['auto', 'low'],
      inputFidelities: /mini/i.test(id) ? undefined : ['low', 'high'],
      outputCompressionRange: { min: 0, max: 100 },
      supportsImageEditing: true,
      maxInputImages: 16,
      maxPromptChars: 32_000,
      pricing: documentedOpenAIImagePricing(id),
    };
  }
  if (isOpenAIGptImageId(id)) {
    return {
      id,
      qualities: GPT_QUALITIES,
      sizes: GPT_SIZES,
      outputFormats: ['png', 'jpeg', 'webp'],
      backgrounds: ['auto', 'opaque', 'transparent'],
      moderationLevels: ['auto', 'low'],
      inputFidelities: /mini/i.test(id) ? undefined : ['low', 'high'],
      outputCompressionRange: { min: 0, max: 100 },
      supportsImageEditing: true,
      maxInputImages: 16,
      maxPromptChars: 32_000,
      pricing: documentedOpenAIImagePricing(id),
    };
  }
  if (/^dall-?e-?3(?:$|-)/i.test(id)) {
    return {
      id,
      name: 'DALL-E 3',
      qualities: ['standard', 'hd'],
      sizes: ['1024x1024', '1792x1024', '1024x1792'],
      supportsImageEditing: false,
    };
  }
  if (/^dall-?e-?2(?:$|-)/i.test(id)) {
    return {
      id,
      name: 'DALL-E 2',
      sizes: ['256x256', '512x512', '1024x1024'],
      // DALL-E 2 has a legacy edit endpoint, but it only accepts square PNGs
      // under older constraints. Treating arbitrary editor images as editable
      // would make the capability badge misleading.
      supportsImageEditing: false,
    };
  }
  return null;
}

export const openaiImageAdapter: ImageAdapter = {
  async listModels(apiKey, baseUrl) {
    const base = baseUrl ?? OPENAI_BASE;
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw normalizeProviderError(response.status, await response.text().catch(() => ''));
    }
    const json = await response.json() as { data?: { id?: unknown }[] };
    return (json.data ?? [])
      .map((entry) => typeof entry.id === 'string' ? directOpenAIImageModel(entry.id) : null)
      .filter((model): model is ImageModelInfo => !!model);
  },
  generate: (apiKey, opts, baseUrl) => {
    const dalle = /^dall-?e/i.test(opts.model);
    return postImage(
      `${baseUrl ?? OPENAI_BASE}/images/generations`,
      apiKey,
      opts,
      undefined,
      dalle ? { response_format: 'b64_json' } : undefined,
    );
  },
  async edit(apiKey, opts, baseUrl) {
    const form = new FormData();
    const sourceExtension = opts.image.type === 'image/jpeg'
      ? 'jpg'
      : opts.image.type === 'image/webp' ? 'webp' : 'png';
    form.append('model', opts.model);
    form.append('prompt', opts.prompt);
    form.append('n', '1');
    form.append('image[]', opts.image, `scatter-input.${sourceExtension}`);
    for (const [index, reference] of (opts.referenceImages ?? []).entries()) {
      form.append('image[]', reference, `scatter-reference-${index + 1}.png`);
    }
    if (opts.quality) form.append('quality', opts.quality);
    if (opts.size) form.append('size', opts.size);
    if (opts.outputFormat) form.append('output_format', opts.outputFormat);
    if (opts.background) form.append('background', opts.background);
    if (opts.outputCompression != null) form.append('output_compression', String(opts.outputCompression));
    if (opts.moderation) form.append('moderation', opts.moderation);
    if (opts.inputFidelity) form.append('input_fidelity', opts.inputFidelity);
    const response = await fetch(`${baseUrl ?? OPENAI_BASE}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: opts.signal,
    });
    if (!response.ok) {
      throw normalizeProviderError(response.status, await response.text().catch(() => ''));
    }
    return parseGeneratedImage(await response.json(), mimeForFormat(opts.outputFormat));
  },
};

export function parseOpenRouterImageModel(entry: Record<string, unknown>): ImageModelInfo | null {
  const id = typeof entry.id === 'string' ? entry.id : '';
  if (!id) return null;
  const params = entry.supported_parameters as Record<string, unknown> | undefined;
  const qualities = enumValues(params?.quality);
  const architecture = entry.architecture as { input_modalities?: unknown } | undefined;
  const inputModalities = Array.isArray(architecture?.input_modalities)
    ? architecture.input_modalities.filter((value): value is string => typeof value === 'string')
    : [];
  const directId = id.replace(/^openai\//i, '');
  const inferredOpenAI = /^openai\//i.test(id) ? directOpenAIImageModel(directId) : null;
  const referenceRange = rangeValue(params?.input_references);
  const maxInputImages = referenceRange && Number.isInteger(referenceRange.max) && referenceRange.max >= 0
    ? referenceRange.max : undefined;
  return {
    id,
    name: typeof entry.name === 'string' ? entry.name : undefined,
    qualities: qualities?.length ? qualities : inferredOpenAI?.qualities,
    sizes: enumValues(params?.size) ?? inferredOpenAI?.sizes,
    resolutions: enumValues(params?.resolution),
    aspectRatios: enumValues(params?.aspect_ratio),
    outputFormats: enumValues(params?.output_format) ?? inferredOpenAI?.outputFormats,
    backgrounds: enumValues(params?.background) ?? inferredOpenAI?.backgrounds,
    moderationLevels: enumValues(params?.moderation) ?? inferredOpenAI?.moderationLevels,
    outputCompressionRange: rangeValue(params?.output_compression) ?? inferredOpenAI?.outputCompressionRange,
    supportsSeed: parameterSupported(params?.seed),
    seedRange: rangeValue(params?.seed),
    inputFidelities: enumValues(params?.input_fidelity) ?? inferredOpenAI?.inputFidelities,
    supportsImageEditing: maxInputImages != null ? maxInputImages > 0
      : params?.input_references === false ? false : parameterSupported(params?.input_references)
      || (inputModalities.length
        ? inputModalities.includes('image')
        : inferredOpenAI?.supportsImageEditing ?? false),
    // Routed endpoints need their own advertised limit, not the direct API's.
    maxInputImages,
    supportsCustomSize: inferredOpenAI?.supportsCustomSize,
    maxPromptChars: inferredOpenAI?.maxPromptChars,
  };
}

export function parseOpenRouterImagePricing(json: unknown): ImagePriceLine[] {
  const endpoints = (json as { endpoints?: unknown })?.endpoints;
  if (!Array.isArray(endpoints)) return [];
  const lines: ImagePriceLine[] = [];
  for (const rawEndpoint of endpoints) {
    if (!rawEndpoint || typeof rawEndpoint !== 'object') continue;
    const endpoint = rawEndpoint as Record<string, unknown>;
    const providerRoute = typeof endpoint.provider_slug === 'string'
      ? endpoint.provider_slug
      : typeof endpoint.provider_name === 'string' ? endpoint.provider_name : undefined;
    if (!Array.isArray(endpoint.pricing)) continue;
    for (const rawLine of endpoint.pricing) {
      if (!rawLine || typeof rawLine !== 'object') continue;
      const line = rawLine as Record<string, unknown>;
      const billable = typeof line.billable === 'string' ? line.billable : '';
      const unit = typeof line.unit === 'string' ? line.unit : '';
      const parsedCost = typeof line.cost_usd === 'number'
        ? line.cost_usd
        : typeof line.cost_usd === 'string' ? Number(line.cost_usd) : Number.NaN;
      if (!billable || !unit || !Number.isFinite(parsedCost) || parsedCost < 0) continue;
      lines.push({
        billable,
        unit,
        costUsd: parsedCost,
        variant: typeof line.variant === 'string' ? line.variant : undefined,
        providerRoute,
        source: 'provider',
      });
    }
  }
  return lines;
}

export const openrouterImageAdapter: ImageAdapter = {
  async listModels(apiKey, baseUrl) {
    const base = baseUrl ?? OPENROUTER_BASE;
    const response = await fetch(`${base}/images/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, ...OPENROUTER_HEADERS },
    });
    if (!response.ok) {
      throw normalizeProviderError(response.status, await response.text().catch(() => ''));
    }
    const json = await response.json() as { data?: Record<string, unknown>[] };
    return (json.data ?? [])
      .map(parseOpenRouterImageModel)
      .filter((model): model is ImageModelInfo => !!model);
  },
  async listPricing(apiKey, model, baseUrl) {
    const base = baseUrl ?? OPENROUTER_BASE;
    const encodedModel = model.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${base}/images/models/${encodedModel}/endpoints`, {
      headers: { Authorization: `Bearer ${apiKey}`, ...OPENROUTER_HEADERS },
    });
    if (!response.ok) {
      throw normalizeProviderError(response.status, await response.text().catch(() => ''));
    }
    return parseOpenRouterImagePricing(await response.json());
  },
  generate: (apiKey, opts, baseUrl) =>
    postImage(`${baseUrl ?? OPENROUTER_BASE}/images`, apiKey, opts, OPENROUTER_HEADERS),
  async edit(apiKey, opts, baseUrl) {
    const references = await Promise.all([opts.image, ...(opts.referenceImages ?? [])].map(async (image) => {
      const bytes = new Uint8Array(await image.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return { type: 'image_url', image_url: { url: `data:${image.type || 'image/png'};base64,${btoa(binary)}` } };
    }));
    return postImage(
      `${baseUrl ?? OPENROUTER_BASE}/images`,
      apiKey,
      opts,
      OPENROUTER_HEADERS,
      {
        input_references: references,
        ...(opts.inputFidelity ? { input_fidelity: opts.inputFidelity } : {}),
      },
    );
  },
};
