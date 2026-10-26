const MAX_VISION_IMAGE_BYTES = 2_000_000;
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Download a catalog thumbnail in the user's browser and turn it into a
 * provider-neutral image input. Providers never receive the catalog URL, and
 * one upstream image host cannot rate-limit the model provider's shared IP. */
export async function visionImageDataUrl(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Image thumbnail returned HTTP ${response.status}.`);
  const blob = await response.blob();
  const mime = blob.type.toLowerCase().split(';')[0] ?? '';
  if (!SUPPORTED_IMAGE_TYPES.has(mime)) throw new Error(`Unsupported vision image type: ${mime || 'unknown'}.`);
  if (!blob.size || blob.size > MAX_VISION_IMAGE_BYTES) {
    throw new Error('Image thumbnail is empty or too large for visual assessment.');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}
