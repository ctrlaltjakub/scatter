import type { EditImageOpts, GenerateImageOpts, GeneratedImage, ImageAdapter } from './types';
import { listGeminiModels, parseGeminiImageModel } from './geminiModels';
import { geminiBlobInput, geminiRequest } from './gemini';
import { ProviderError } from './errors';

async function requestImage(key: string, opts: GenerateImageOpts, base?: string, images: Blob[] = []): Promise<GeneratedImage> {
  // Native Interactions currently accepts JPEG output only (PNG remains a
  // valid input). Do not send a stale output-format setting from another provider.
  const format: Record<string, string> = { type: 'image', mime_type: 'image/jpeg' };
  if (opts.aspectRatio && opts.aspectRatio !== 'auto') format.aspect_ratio = opts.aspectRatio;
  if (opts.resolution && opts.resolution !== 'auto') format.image_size = opts.resolution;
  const response = await geminiRequest(key, { model: opts.model,
    input: [{ type: 'text', text: opts.prompt }, ...await Promise.all(images.map(geminiBlobInput))],
    response_format: format,
  }, base, opts.signal);
  const result = await response.json() as { status?: string; steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; mime_type?: string }> }> };
  if (result.status === 'incomplete') throw new ProviderError('The image generation reached Google’s output limit. Try a lower resolution.', { kind: 'output_limit' });
  const image = result.steps?.filter(step => step.type === 'model_output').flatMap(step => step.content ?? [])
    .find(part => part.type === 'image' && part.data);
  if (!image?.data) throw new ProviderError('Google returned no image. The prompt may have been blocked, or the selected model may not support image generation.', { kind: 'bad_request' });
  if (!/^image\/(?:png|jpeg|webp)$/.test(image.mime_type ?? '')) throw new Error('Google returned an unsupported image format.');
  const binary = atob(image.data);
  return { bytes: Uint8Array.from(binary, char => char.charCodeAt(0)), mime: image.mime_type! };
}

export const geminiImageAdapter: ImageAdapter = {
  async listModels(key, base) {
    return (await listGeminiModels(key, base)).filter(model => model.supportedGenerationMethods?.includes('generateContent'))
      .flatMap(model => { const image = parseGeminiImageModel(model); return image ? [image] : []; });
  },
  generate: requestImage,
  edit(key: string, opts: EditImageOpts, base?: string) {
    return requestImage(key, opts, base, [opts.image, ...opts.referenceImages ?? []]);
  },
};
