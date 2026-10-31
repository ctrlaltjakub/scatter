import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareChatAttachments } from './attachments';
import { deleteAsset, saveAsset } from '@/opfs/assetsIO';
import { extractSourceBlob } from '@/lib/sourceExtraction';
import { collectReferencedAssetIds } from '@/lib/projectBranch';
import { appendChatAnswer, createChatNode } from './model';
import { flushChatDrafts, localChatDraftAssetIds, parseChatDraft, useChatRuntimeStore } from '@/store/useChatRuntimeStore';

vi.mock('@/opfs/assetsIO', () => ({ saveAsset: vi.fn(), deleteAsset: vi.fn() }));
vi.mock('@/lib/sourceExtraction', () => ({
  sourceKindForFile: (file: File) => file.type.startsWith('image/') ? 'image' : file.name.endsWith('.pdf') ? 'pdf' : file.name.endsWith('.txt') ? 'text' : null,
  extractSourceBlob: vi.fn(async () => ({ blocks: [{ text: 'A readable page.', page: 1 }], pageCount: 1 })),
}));
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); useChatRuntimeStore.setState({ drafts: {} }); });

describe('message attachments', () => {
  it.each([
    [1, 0, '0/1 page'],
    [1, 1, '1/1 page'],
    [3, 1, '1/3 pages'],
    [3, 3, '3/3 pages'],
  ])('reports PDF progress using the total page count (%s total, %s complete)', async (pageCount, completed, label) => {
    vi.mocked(extractSourceBlob).mockImplementationOnce(async (_blob, _kind, _signal, onProgress) => {
      await onProgress?.({ stage: 'ocr', page: 1, pageCount,
        completedPages: Array.from({ length: completed }, (_, index) => index + 1), text: 'A readable page.' });
      return { blocks: [{ id: 'page-1', text: 'A readable page.', page: 1 }], pageCount, retainOriginal: true };
    });
    const progress = vi.fn();
    await prepareChatAttachments('p', [new File(['pdf'], 'notes.pdf', { type: 'application/pdf' })], new AbortController().signal, progress);

    expect(progress).toHaveBeenLastCalledWith(`Reading notes.pdf: ${label}…`);
  });

  it('keeps image bytes outside JSON and extracts document text without indexing sources', async () => {
    const image = new File(['png'], 'photo.png', { type: 'image/png' });
    const pdf = new File(['pdf'], 'notes.pdf', { type: 'application/pdf' });
    const items = await prepareChatAttachments('p', [image, pdf], new AbortController().signal);
    expect(saveAsset).toHaveBeenCalledWith('p', expect.any(String), image);
    expect(extractSourceBlob).toHaveBeenCalledTimes(1);
    expect(items[1]).toMatchObject({ kind: 'text', name: 'notes.pdf', text: '[Page 1]\nA readable page.' });
    expect(items[0]?.text).toBeUndefined();
    let node = createChatNode({ id: 'c', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    node = appendChatAnswer(node, { turnId: 't', createdAt: 2, question: 'Explain', metadata: { attachments: items } });
    expect([...collectReferencedAssetIds([node])]).toEqual([items[0]!.media!.assetId]);
  });
  it('cleans up partial image assets when a later file fails', async () => {
    await expect(prepareChatAttachments('p', [new File(['png'], 'p.png', { type: 'image/png' }), new File(['bad'], 'program.exe')], new AbortController().signal))
      .rejects.toThrow('unsupported');
    expect(deleteAsset).toHaveBeenCalledWith('p', expect.any(String));
  });
  it('rejects unsupported image formats with an actionable explanation', async () => {
    await expect(prepareChatAttachments('p', [new File(['svg'], 'p.svg', { type: 'image/svg+xml' })], new AbortController().signal))
      .rejects.toThrow('PNG, JPG, or WebP');
  });
  it('preserves an image-only draft on reload and protects its assets from sweeping', () => {
    const draft = { text: '', attachments: [{ id: 'i', name: 'Image.png', kind: 'image' as const,
      media: { kind: 'image' as const, source: 'asset' as const, assetId: 'keep-me' } }] };
    useChatRuntimeStore.getState().setDraft('p', 'c', draft); flushChatDrafts();
    localStorage.setItem('scatter.chat.draft.p.broken', '{');
    useChatRuntimeStore.setState({ drafts: {} });
    expect([...localChatDraftAssetIds('p')]).toEqual(['keep-me']);
    expect([...localChatDraftAssetIds('another')]).toEqual([]);
    expect(parseChatDraft(JSON.parse(localStorage.getItem('scatter.chat.draft.p.c')!))?.attachments).toEqual(draft.attachments);
  });
});
