import type { MediaRef } from '@/store/types';
import { loadAsset } from '@/opfs/assetsIO';

/** OPFS files are named by asset ID and do not retain the uploaded MIME type.
 * Restore the saved media type before producing a provider image input. */
export async function chatImageInput(projectId: string, media?: MediaRef): Promise<string | undefined> {
  if (!media) return undefined;
  if (media.source === 'link' && media.url) return media.url;
  const blob = media.assetId && await loadAsset(projectId, media.assetId);
  if (!blob) throw new Error('An attached image is unavailable. Reattach it before sending.');
  const extension = media.fileName?.split('.').at(-1)?.toLowerCase();
  const fromName = extension === 'jpg' ? 'image/jpeg' : `image/${extension ?? ''}`;
  const mime = [media.mime, blob.type, fromName].find((type) =>
    type && /^image\/(?:png|jpeg|webp|gif)$/i.test(type));
  if (!mime) throw new Error('The attached image type is unavailable or unsupported. Reattach a PNG, JPG, WebP, or GIF image.');
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The attached image could not be read.'));
    reader.readAsDataURL(blob.slice(0, blob.size, mime));
  });
}
