import { describe, expect, it } from 'vitest';
import {
  buildSelectedTextImagePrompt,
  imagePlaceholderFit,
  preservedImageEditGeometry,
  configuredImageModelAvailable,
  configuredImageEditingAvailable,
} from './imageGeneration';
import { validCustomImageSize } from './imageGenerationSettings';
import type { ProviderAccount } from '@/store/types';

describe('explicit image compatibility override', () => {
  const ref = { providerId: 'provider', model: 'unlisted-image-model' };
  const providers: ProviderAccount[] = [{ id: 'provider', preset: 'openai', apiKey: 'test', enabledModels: [] }];
  it('permits manual models absent from the filtered image catalog only when enabled', () => {
    expect(configuredImageModelAvailable(ref, providers, { provider: [] })).toBe(false);
    expect(configuredImageModelAvailable(ref, providers, { provider: [] }, true)).toBe(true);
    expect(configuredImageEditingAvailable(ref, providers, { provider: [{ id: ref.model }] })).toBe(false);
    expect(configuredImageEditingAvailable(ref, providers, { provider: [{ id: ref.model }] }, true)).toBe(true);
  });
  it('does not bypass missing credentials, a disabled role, or an unsupported image API', () => {
    expect(configuredImageEditingAvailable(null, providers, {}, true)).toBe(false);
    expect(configuredImageEditingAvailable(ref, [{ ...providers[0]!, apiKey: '' }], {}, true)).toBe(false);
    expect(configuredImageEditingAvailable(ref, [{ ...providers[0]!, preset: 'ollama' }], {}, true)).toBe(false);
  });
});

describe('selected-text image prompt', () => {
  it('keeps the exact selection, cleans node markup, and gives context a neutral role', () => {
    const prompt = buildSelectedTextImagePrompt({
      selectedText: 'the exact [[selected phrase]]',
      sourceTitle: 'A **title**',
      sourceBody: '# Heading\n- [[Term]] does a thing ⟦2⟧',
    });
    expect(prompt).toContain('Selected passage: the exact [[selected phrase]]');
    expect(prompt).toContain('Source node context: Heading\nTerm does a thing');
    expect(prompt).toContain('context only to disambiguate meaning');
    expect(prompt).not.toContain('⟦2⟧');
  });

  it('truncates context before selection and rejects a selection that cannot fit', () => {
    const selectedText = 'PRIMARY PASSAGE';
    const prompt = buildSelectedTextImagePrompt({
      selectedText, sourceTitle: 'Title', sourceBody: 'context '.repeat(500), maxChars: 700,
    });
    expect(prompt.length).toBeLessThanOrEqual(700);
    expect(prompt).toContain(selectedText);
    expect(prompt).toContain('…');
    expect(() => buildSelectedTextImagePrompt({
      selectedText: 'x'.repeat(1_000), sourceTitle: 'T', sourceBody: '', maxChars: 300,
    })).toThrow(/selected passage is too long/i);
  });
});

describe('GPT Image custom size validation', () => {
  it('accepts the landscape default and rejects invalid multiples, ratios, and pixel counts', () => {
    expect(validCustomImageSize(1536, 1024)).toBe(true);
    expect(validCustomImageSize(1537, 1024)).toBe(false);
    expect(validCustomImageSize(3840, 512)).toBe(false);
    expect(validCustomImageSize(320, 320)).toBe(false);
  });
});

describe('image generation placeholder sizing', () => {
  it('uses the same fit calculation as the requested final OpenAI image', () => {
    expect(imagePlaceholderFit({ size: '1536x1024' })).toEqual({ width: 624, bodyMaxHeight: 416 });
    expect(imagePlaceholderFit({ size: '1024x1024' })).toEqual({ width: 624, bodyMaxHeight: 624 });
    expect(imagePlaceholderFit({ size: '512x512' })).toEqual({ width: 512, bodyMaxHeight: 512 });
  });

  it('reserves the normal media box for ratio-only providers', () => {
    expect(imagePlaceholderFit({ aspectRatio: '2:3' })).toEqual({ width: 416, bodyMaxHeight: 624 });
    expect(imagePlaceholderFit({})).toEqual({ width: 624, bodyMaxHeight: 416 });
  });
});

describe('image edit geometry', () => {
  it('chooses the closest provider shape instead of silently changing the frame', () => {
    expect(preservedImageEditGeometry({
      id: 'google/image', resolutions: ['1K', '2K', '4K'], aspectRatios: ['1:1', '3:2', '2:3'],
    }, 1800, 1200)).toEqual({ resolution: '2K', aspectRatio: '3:2' });
    expect(preservedImageEditGeometry({
      id: 'fixed/image', sizes: ['1024x1024', '1536x1024', '1024x1536'],
    }, 1600, 1000)).toEqual({ size: '1536x1024' });
  });

  it('uses a valid custom GPT Image 2 size for unusual edited frames', () => {
    const geometry = preservedImageEditGeometry({
      id: 'gpt-image-2', sizes: ['auto', 'custom'], supportsCustomSize: true,
    }, 1400, 900);
    expect(geometry.size).toMatch(/^\d+x\d+$/);
    const match = geometry.size!.match(/^(\d+)x(\d+)$/)!;
    const width = Number(match[1]);
    const height = Number(match[2]);
    expect(width % 16).toBe(0);
    expect(height % 16).toBe(0);
    expect(validCustomImageSize(width, height)).toBe(true);
  });
});
