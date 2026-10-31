import type { ChatAttachment } from '@/store/chatTypes';
import { saveAsset, deleteAsset } from '@/opfs/assetsIO';
import { newId } from '@/lib/ids';

/** Extract documents once; images remain real vision inputs. The source
 * library and its indexing queue are deliberately untouched. */
export async function prepareChatAttachments(projectId: string, files: readonly File[], signal: AbortSignal,
  progress: (message: string) => void = () => {}): Promise<ChatAttachment[]> {
  const { sourceKindForFile, extractSourceBlob } = await import('@/lib/sourceExtraction');
  const saved: string[] = [];
  const attachments: ChatAttachment[] = [];
  try {
    for (const file of files) {
      signal.throwIfAborted();
      const kind = sourceKindForFile(file);
      if (!kind) throw new Error(`${file.name}: unsupported file type.`);
      progress(`Preparing ${file.name}…`);
      const id = newId();
      if (kind === 'image') {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type.toLowerCase())) {
          throw new Error(`${file.name}: use a PNG, JPG, or WebP image for chat.`);
        }
        const assetId = newId();
        await saveAsset(projectId, assetId, file); saved.push(assetId);
        attachments.push({ id, name: file.name, kind: 'image', media: {
          kind: 'image', source: 'asset', assetId, mime: file.type,
          fileName: file.name, byteSize: file.size,
        } });
      } else {
        const extracted = await extractSourceBlob(file, kind, signal, (state) => {
          progress(`Reading ${file.name}: ${state.completedPages.length}/${state.pageCount} page${state.pageCount === 1 ? '' : 's'}…`);
        });
        const text = extracted.blocks.map((block) => `${block.page ? `[Page ${block.page}]\n` : ''}${block.text}`).join('\n\n');
        if (!text.trim()) throw new Error(`${file.name}: no readable text was found.`);
        attachments.push({ id, name: file.name, kind: 'text', text, pageCount: extracted.pageCount });
      }
    }
    signal.throwIfAborted();
    return attachments;
  } catch (error) {
    await Promise.allSettled(saved.map((id) => deleteAsset(projectId, id)));
    throw error;
  }
}
