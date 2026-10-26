import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openaiImageAdapter,
  openrouterImageAdapter,
  parseOpenRouterImageModel,
  parseOpenRouterImagePricing,
} from './images';

const originalFetch = globalThis.fetch;

beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('image provider adapters', () => {
  it('discovers all supported image-generation families from direct OpenAI', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [
        { id: 'gpt-5.4' }, { id: 'gpt-image-2' }, { id: 'gpt-image-1' },
        { id: 'gpt-5.4-image-2' }, { id: 'dall-e-3' },
      ] }),
    } as Response);
    const models = await openaiImageAdapter.listModels('key');
    expect(models.map((model) => model.id)).toEqual([
      'gpt-image-2', 'gpt-image-1', 'gpt-5.4-image-2', 'dall-e-3',
    ]);
    expect(models[0]).toMatchObject({ supportsCustomSize: true, maxPromptChars: 32_000, maxInputImages: 16 });
    expect(models[0]?.pricing).toContainEqual(expect.objectContaining({
      quality: 'high', size: '1536x1024', costUsd: 0.165,
    }));
    expect(models[2]).toMatchObject({ supportsCustomSize: true, qualities: ['auto', 'low', 'medium', 'high'] });
    expect(models[3]).toMatchObject({ qualities: ['standard', 'hd'] });
  });

  it('parses and requests OpenRouter per-endpoint image pricing', async () => {
    const response = {
      endpoints: [
        {
          provider_slug: 'google',
          pricing: [
            { billable: 'output_image', unit: 'image', cost_usd: 0.04, variant: '2k' },
            { billable: 'input_reference', unit: 'megapixel', cost_usd: '0.015' },
          ],
        },
        { provider_name: 'Other route', pricing: [
          { billable: 'output_image', unit: 'token', cost_usd: 0.000008 },
          { billable: 'broken', unit: 'image', cost_usd: 'not-a-number' },
        ] },
      ],
    };
    expect(parseOpenRouterImagePricing(response)).toEqual([
      expect.objectContaining({ billable: 'output_image', unit: 'image', costUsd: 0.04, variant: '2k', providerRoute: 'google' }),
      expect.objectContaining({ billable: 'input_reference', unit: 'megapixel', costUsd: 0.015, providerRoute: 'google' }),
      expect.objectContaining({ billable: 'output_image', unit: 'token', costUsd: 0.000008, providerRoute: 'Other route' }),
    ]);

    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => response } as Response);
    await openrouterImageAdapter.listPricing!('key', 'google/gemini-3-pro-image-preview');
    expect(fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/images/models/google/gemini-3-pro-image-preview/endpoints',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer key' }) }),
    );
  });

  it('uses OpenAI Images generations with the chosen quality and size', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: btoa('png') }] }),
    } as Response);
    const image = await openaiImageAdapter.generate('key', {
      model: 'gpt-image-2', prompt: 'owl', quality: 'high', size: '1536x1024',
    });
    expect(image.mime).toBe('image/png');
    expect(new TextDecoder().decode(image.bytes)).toBe('png');
    expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/images/generations', expect.any(Object));
    const request = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      model: 'gpt-image-2', prompt: 'owl', quality: 'high', size: '1536x1024', n: 1,
    });
  });

  it('parses controls for every model returned by OpenRouter image discovery', () => {
    expect(parseOpenRouterImageModel({
      id: 'google/gemini-3-pro-image-preview',
      name: 'Nano Banana Pro',
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: {
        resolution: { type: 'enum', values: ['1K', '2K', '4K'] },
        aspect_ratio: { type: 'enum', values: ['1:1', '3:2'] },
        output_format: { type: 'enum', values: ['png', 'jpeg'] },
        output_compression: { type: 'range', min: 10, max: 95 },
        seed: { type: 'range', min: 0, max: 2_147_483_647 },
        input_fidelity: { type: 'enum', values: ['low', 'high'] },
        input_references: { type: 'range', min: 0, max: 14 },
      },
    })).toMatchObject({
      resolutions: ['1K', '2K', '4K'],
      aspectRatios: ['1:1', '3:2'],
      outputFormats: ['png', 'jpeg'],
      outputCompressionRange: { min: 10, max: 95 },
      supportsSeed: true,
      seedRange: { min: 0, max: 2_147_483_647 },
      inputFidelities: ['low', 'high'],
      supportsImageEditing: true,
      maxInputImages: 14,
    });
    expect(parseOpenRouterImageModel({ id: 'bytedance/seedream' })).toMatchObject({
      id: 'bytedance/seedream', supportsImageEditing: false, supportsSeed: false,
    });
  });

  it('honors routed input-image limits and treats missing limits as unknown', () => {
    for (const max of [0, 1, 2, 3, 14]) {
      expect(parseOpenRouterImageModel({ id: 'vendor/edit', architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: { input_references: { type: 'range', min: 0, max } },
      })).toMatchObject({ maxInputImages: max, supportsImageEditing: max > 0 });
    }
    expect(parseOpenRouterImageModel({ id: 'openai/gpt-image-2' })?.maxInputImages).toBeUndefined();
    expect(parseOpenRouterImageModel({ id: 'vendor/edit', architecture: { input_modalities: ['image'] },
      supported_parameters: { input_references: false },
    })?.supportsImageEditing).toBe(false);
  });

  it('requests base64 output for DALL-E without sending GPT-only output_format', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: btoa('dalle') }] }),
    } as Response);
    await openaiImageAdapter.generate('key', {
      model: 'dall-e-3', prompt: 'owl', quality: 'hd', size: '1792x1024',
    });
    const request = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(request.body as string);
    expect(body.response_format).toBe('b64_json');
    expect(body.output_format).toBeUndefined();
  });

  it('uses the dedicated OpenRouter image endpoint and Gemini controls', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: btoa('image'), media_type: 'image/png' }] }),
    } as Response);
    await openrouterImageAdapter.generate('or-key', {
      model: 'google/gemini-3-pro-image-preview', prompt: 'cell', resolution: '2K', aspectRatio: '3:2',
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      model: 'google/gemini-3-pro-image-preview', resolution: '2K', aspect_ratio: '3:2',
    });
  });

  it('sends direct OpenAI edits as multipart input with the advanced options', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: btoa('edited') }] }),
    } as Response);
    await openaiImageAdapter.edit!('key', {
      model: 'gpt-image-2', prompt: 'make the sky darker',
      image: new Blob(['source'], { type: 'image/webp' }),
      referenceImages: [new Blob(['mask'], { type: 'image/png' }), new Blob(['close-up'], { type: 'image/png' })],
      quality: 'high', size: '1536x1024', outputFormat: 'webp',
      background: 'opaque', outputCompression: 82, moderation: 'low',
      inputFidelity: 'high',
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer key' });
    const form = (init as RequestInit).body as FormData;
    expect(form.get('prompt')).toBe('make the sky darker');
    expect(form.get('image[]')).toBeInstanceOf(Blob);
    expect(form.getAll('image[]')).toHaveLength(3);
    expect(await Promise.all((form.getAll('image[]') as Blob[]).map((image) => image.text()))).toEqual(['source', 'mask', 'close-up']);
    expect(form.get('output_format')).toBe('webp');
    expect(form.get('output_compression')).toBe('82');
    expect(form.get('input_fidelity')).toBe('high');
  });

  it('sends OpenRouter edits through the same image API with a base64 reference', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: btoa('edited') }] }),
    } as Response);
    await openrouterImageAdapter.edit!('or-key', {
      model: 'google/gemini-3-pro-image-preview', prompt: 'add labels',
      image: new Blob(['source'], { type: 'image/png' }),
      referenceImages: [new Blob(['mask'], { type: 'image/png' }), new Blob(['close-up'], { type: 'image/png' })],
      resolution: '2K', aspectRatio: '3:2', seed: 42,
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      model: 'google/gemini-3-pro-image-preview', prompt: 'add labels',
      resolution: '2K', aspect_ratio: '3:2', seed: 42,
    });
    expect(body.input_references[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(body.input_references).toHaveLength(3);
    expect(body.input_references[1].image_url.url).toBe(`data:image/png;base64,${btoa('mask')}`);
    expect(body.input_references[2].image_url.url).toBe(`data:image/png;base64,${btoa('close-up')}`);
  });
});
