import { describe, expect, it, vi } from 'vitest';
import { loadAsset } from '@/opfs/assetsIO';
import { chatImageInput } from './imageInput';

vi.mock('@/opfs/assetsIO', () => ({ loadAsset: vi.fn() }));
describe('chat image input', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])('restores %s after storage', async (mime) => {
    vi.mocked(loadAsset).mockResolvedValueOnce(new Blob(['image bytes']));
    expect(await chatImageInput('p', { kind: 'image', source: 'asset', assetId: 'a', mime }))
      .toMatch(new RegExp(`^data:${mime};base64,`));
  });
  it('uses the original filename for legacy records without MIME metadata', async () => {
    vi.mocked(loadAsset).mockResolvedValueOnce(new Blob(['image bytes']));
    expect(await chatImageInput('p', { kind: 'image', source: 'asset', assetId: 'a', fileName: 'Screenshot.JPG' }))
      .toMatch(/^data:image\/jpeg;base64,/);
  });
  it('never sends a generic binary input when image type is unknown', async () => {
    vi.mocked(loadAsset).mockResolvedValueOnce(new Blob(['unknown bytes']));
    await expect(chatImageInput('p', { kind: 'image', source: 'asset', assetId: 'a' })).rejects.toThrow('Reattach');
  });
});
