import { afterEach, describe, expect, it, vi } from 'vitest';
import { visionImageDataUrl } from './visionImageInput';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('visionImageDataUrl', () => {
  it('embeds supported thumbnail bytes without exposing the catalog URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'image/png' }),
    }) as unknown as typeof fetch;
    const result = await visionImageDataUrl('https://catalog.example/secret-file-name.png');
    expect(result).toBe('data:image/png;base64,AAECAw==');
    expect(result).not.toContain('catalog.example');
  });

  it('rejects failed, unsupported, and oversized thumbnails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 }) as unknown as typeof fetch;
    await expect(visionImageDataUrl('https://example.org/limited')).rejects.toThrow(/429/);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, blob: async () => new Blob(['svg'], { type: 'image/svg+xml' }),
    }) as unknown as typeof fetch;
    await expect(visionImageDataUrl('https://example.org/vector')).rejects.toThrow(/unsupported/i);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, blob: async () => new Blob([new Uint8Array(2_000_001)], { type: 'image/jpeg' }),
    }) as unknown as typeof fetch;
    await expect(visionImageDataUrl('https://example.org/large')).rejects.toThrow(/too large/i);
  });
});
