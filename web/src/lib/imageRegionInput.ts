import { configuredPrompt } from '@/lib/configuredPrompt';
import type { ImageQuestionContext, ImageRegion, MediaRef } from '@/store/types';
import type { ChatImageInput } from '@/providers/types';
import { loadAsset } from '@/opfs/assetsIO';
import { isStillImageMedia } from './imageEditActions';
import { imageRegionBounds, imageRegionsDescription, normalizedImageRegions } from './imageRegions';
import { imageQuestionInstructions } from './imageQuestionPrompt';
import { useSettingsStore } from '@/store/useSettingsStore';

export async function loadImageMediaBlob(projectId: string, media: MediaRef, signal?: AbortSignal): Promise<Blob> {
  if (!isStillImageMedia(media)) throw new Error('This action is available only for still images, not GIFs or videos.');
  let blob: Blob | null = null;
  if (media.source === 'asset' && media.assetId) blob = await loadAsset(projectId, media.assetId);
  else if (media.source === 'link' && media.url) {
    let response: Response;
    try { response = await fetch(media.url, { mode: 'cors', signal }); }
    catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('This website does not allow Scatter to read the image. Upload the image file instead.');
    }
    if (!response.ok) throw new Error(`Could not read the image (HTTP ${response.status}). Try uploading the image file instead.`);
    blob = await response.blob();
  }
  if (!blob?.size) throw new Error('The source image is missing. Upload it again before continuing.');
  if (blob.type.toLowerCase().split(';')[0] === 'image/gif') throw new Error('GIFs cannot be used for still-image interactions.');
  // The app displays SVG/AVIF too, but image-edit providers generally accept
  // PNG/JPEG/WebP only. Rasterize unsupported input formats, never the GIFs
  // excluded above. This also repairs application/octet-stream download MIME.
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type.toLowerCase())) {
    const source = await decode(blob);
    try {
      if (source.width * source.height > 40_000_000) throw new Error('This image is too large to prepare. Resize it in the image editor first.');
      const { canvas, ctx } = canvasFor(source.width, source.height);
      ctx.drawImage(source.image, 0, 0);
      return await png(canvas);
    } finally { source.close(); }
  }
  return blob;
}

async function decode(blob: Blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { image: bitmap as CanvasImageSource, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { /* SVG and some browser codecs need the HTML image decoder. */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Could not decode the image.'));
      image.src = url;
    });
    return { image: image as CanvasImageSource, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

function canvasFor(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not prepare the image selection.');
  return { canvas, ctx };
}

function png(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (
    blob ? resolve(blob) : reject(new Error('Your browser could not export the image selection.'))
  ), 'image/png'));
}

function visionUrl(canvas: HTMLCanvasElement): string {
  const lossless = canvas.toDataURL('image/png');
  if (lossless.length < 5_000_000) return lossless;
  // Bound photographic requests below common vision-provider image limits,
  // keeping diagrams lossless whenever practical.
  const flat = canvasFor(canvas.width, canvas.height);
  flat.ctx.fillStyle = '#fff';
  flat.ctx.fillRect(0, 0, canvas.width, canvas.height);
  flat.ctx.drawImage(canvas, 0, 0);
  return flat.canvas.toDataURL('image/jpeg', .9);
}

function unionPath(ctx: CanvasRenderingContext2D, regions: readonly ImageRegion[], width: number, height: number) {
  ctx.beginPath();
  for (const r of normalizedImageRegions(regions)) {
    // Align to pixel edges so the selection has no antialiased leakage.
    const x = Math.floor(r.x * width + 1e-7), y = Math.floor(r.y * height + 1e-7);
    ctx.rect(x, y, Math.ceil((r.x + r.width) * width - 1e-7) - x, Math.ceil((r.y + r.height) * height - 1e-7) - y);
  }
}

/** A close-up retains the selection's layout; gaps between disjoint regions
 * are hidden rather than accidentally presented as editable content. */
function selectedImageCloseUp(source: Awaited<ReturnType<typeof decode>>, regions: readonly ImageRegion[], bounds: ImageRegion) {
  const croppedWidth = bounds.width * source.width, croppedHeight = bounds.height * source.height;
  const cropScale = Math.min(1, 2048 / Math.max(croppedWidth, croppedHeight));
  const crop = canvasFor(croppedWidth * cropScale, croppedHeight * cropScale);
  crop.ctx.fillStyle = '#808080';
  crop.ctx.fillRect(0, 0, crop.canvas.width, crop.canvas.height);
  const local = regions.map((r) => ({ x: (r.x - bounds.x) / bounds.width, y: (r.y - bounds.y) / bounds.height,
    width: r.width / bounds.width, height: r.height / bounds.height }));
  unionPath(crop.ctx, local, crop.canvas.width, crop.canvas.height);
  crop.ctx.clip();
  crop.ctx.drawImage(source.image, bounds.x * source.width, bounds.y * source.height, croppedWidth, croppedHeight,
    0, 0, crop.canvas.width, crop.canvas.height);
  return crop.canvas;
}

export type ImageEditReferenceMode = 'mask-and-crop' | 'crop' | 'coordinates';

/** Capability-based, not model-name-based. If the provider does not publish a
 * limit, only the original image is assumed safe; coordinates still locate
 * the selection without claiming an absent mask or crop was attached. */
export function selectedImageEditReferenceMode(maxInputImages?: number): ImageEditReferenceMode {
  if (typeof maxInputImages !== 'number' || !Number.isFinite(maxInputImages)) return 'coordinates';
  return maxInputImages >= 3 ? 'mask-and-crop' : maxInputImages >= 2 ? 'crop' : 'coordinates';
}

/** References follow the exact image ordering in selectedImageEditPrompt.
 * Models with fewer inputs receive the close-up alone or coordinates only. */
export async function prepareSelectedImageEditReferences(
  blob: Blob, regions: readonly ImageRegion[], signal?: AbortSignal, mode: ImageEditReferenceMode = 'mask-and-crop',
): Promise<Blob[]> {
  const valid = normalizedImageRegions(regions);
  const bounds = imageRegionBounds(valid);
  if (!bounds || mode === 'coordinates') return [];
  signal?.throwIfAborted();
  const source = await decode(blob);
  try {
    signal?.throwIfAborted();
    if (source.width * source.height > 40_000_000) throw new Error('This image is too large for a selected-area edit. Resize it in the image editor first.');
    const references: Blob[] = [];
    if (mode === 'mask-and-crop') {
      const ratio = Math.min(1, 2048 / Math.max(source.width, source.height));
      const { canvas, ctx } = canvasFor(source.width * ratio, source.height * ratio);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      unionPath(ctx, valid, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.fill();
      references.push(await png(canvas));
      signal?.throwIfAborted();
    }
    const closeUp = await png(selectedImageCloseUp(source, valid, bounds));
    signal?.throwIfAborted();
    return [...references, closeUp];
  } finally { source.close(); }
}

export function selectedImageEditPrompt(
  instruction: string, regions: readonly ImageRegion[], mode: ImageEditReferenceMode = 'mask-and-crop',
): string {
  const valid = normalizedImageRegions(regions);
  const bounds = imageRegionBounds(valid);
  if (!bounds) return configuredPrompt('imageEditWhole', { instruction });
  const cropNumber = mode === 'mask-and-crop' ? 'THIRD' : 'SECOND';
  const maskGuide = mode === 'mask-and-crop'
    ? configuredPrompt('imageEditMaskGuide') : '';
  const cropGuide = mode !== 'coordinates'
    ? configuredPrompt('imageEditCropGuide', { cropNumber, bounds: imageRegionsDescription([bounds]) }) : '';
  return configuredPrompt('imageEditSelection', { maskGuide, cropGuide, regions: imageRegionsDescription(valid), instruction });
}

/** Upgrade the old two-image wrapper and adapt our current wrapper if the
 * provider's limits change. Arbitrary saved prompts are never rewritten. */
export function upgradeSelectedImageEditPrompt(
  prompt: string, regions: readonly ImageRegion[], mode: ImageEditReferenceMode = 'mask-and-crop',
): string {
  const oldPrefix = "Edit the FIRST image according to the user's instruction below. The SECOND image is a binary selection mask";
  const currentPrefix = "Edit only the selected parts of the FIRST image according to the user's instruction below.";
  const instructionMarker = '\nUser instruction: ';
  const index = prompt.indexOf(instructionMarker);
  if (!regions.length || !(prompt.startsWith(oldPrefix) || prompt.startsWith(currentPrefix)) || index < 0) return prompt;
  return selectedImageEditPrompt(prompt.slice(index + instructionMarker.length), regions, mode);
}

export async function prepareImageQuestion(
  projectId: string, context: ImageQuestionContext, signal?: AbortSignal,
): Promise<{ instructions: string; images: ChatImageInput[] }> {
  const blob = await loadImageMediaBlob(projectId, context.sourceMedia, signal);
  signal?.throwIfAborted();
  const source = await decode(blob);
  try {
    const ratio = Math.min(1, 2048 / Math.max(source.width, source.height));
    const { canvas, ctx } = canvasFor(source.width * ratio, source.height * ratio);
    ctx.drawImage(source.image, 0, 0, canvas.width, canvas.height);
    const images: ChatImageInput[] = [{ id: 'whole-image-context', url: visionUrl(canvas), detail: 'high' }];
    const bounds = imageRegionBounds(context.regions);
    if (bounds) {
      images.push({ id: 'selected-image-parts', url: visionUrl(selectedImageCloseUp(source, context.regions, bounds)), detail: 'high' });
    }
    signal?.throwIfAborted();
    return {
      images,
      instructions: imageQuestionInstructions(context, useSettingsStore.getState().customPrompts),
    };
  } finally { source.close(); }
}
