import { saveAsset } from '@/opfs/assetsIO';
import { useGraphStore } from '@/store/useGraphStore';
import { useMediaUrlStore } from '@/store/useMediaUrlStore';
import type { FreeImageRecommendation, MediaRef, ScatterNode } from '@/store/types';
import { newId } from './ids';
import { fitMediaToWidth } from './mediaSizing';
import { spawnNearParent } from './generate';
import { freeImageAttribution, freeImageSourceLabel } from './freeImageRecommendations';

const MAX_LOCAL_EDGE = 1600;

async function optimizeImage(blob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const ratio = Math.min(1, MAX_LOCAL_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  if (ratio === 1) {
    bitmap.close();
    return { blob, width, height };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('This browser could not prepare the free image.');
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const mime = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const resized = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not resize the free image.')), mime, 0.9);
  });
  return { blob: resized, width, height };
}

/** Commons already provides a downscaled 1600px thumbnail (and a rasterized
 * thumbnail for SVG). Store that local copy so projects remain portable and
 * do not repeatedly hotlink the original. */
async function downloadLocalCopy(result: FreeImageRecommendation): Promise<{
  blob: Blob;
  width: number;
  height: number;
}> {
  const response = await fetch(result.thumbnailUrl, { mode: 'cors' });
  if (!response.ok) throw new Error(`Could not download the ${freeImageSourceLabel(result)} image (HTTP ${response.status}).`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('Wikimedia returned a non-image file.');
  return optimizeImage(blob);
}

export async function spawnWikimediaImageNode(
  parentId: string,
  result: FreeImageRecommendation,
): Promise<string> {
  const project = useGraphStore.getState().project;
  const parent = project?.nodes[parentId];
  if (!project || !parent) throw new Error('The source node is no longer available.');
  const { blob, width, height } = await downloadLocalCopy(result);
  const assetId = newId();
  await saveAsset(project.id, assetId, blob);
  const objectUrl = URL.createObjectURL(blob);
  useMediaUrlStore.getState().set(assetId, objectUrl);
  const media: MediaRef = {
    source: 'asset',
    kind: 'image',
    assetId,
    mime: blob.type,
    byteSize: blob.size,
    naturalWidth: width,
    naturalHeight: height,
    freeImage: freeImageAttribution(result),
  };
  const fit = fitMediaToWidth(width, height);
  const nodeId = newId();
  const node: ScatterNode = {
    id: nodeId,
    type: 'media',
    position: spawnNearParent(parent, Object.values(project.nodes)),
    frozen: false,
    groupId: parent.groupId,
    versions: [{
      header: result.caption,
      headerParts: { subject: result.caption },
      body: '',
      createdAt: Date.now(),
      generatedBy: 'media',
      contentType: 'media',
      width: fit.width,
      bodyMaxHeight: fit.bodyMaxHeight,
      media,
    }],
    currentVersionIndex: 0,
  };
  // Structural content creation belongs in app-level undo/redo. The downloaded
  // OPFS asset may become orphaned after Undo and is reclaimed by the existing
  // orphan sweep.
  useGraphStore.getState().addNodeWithArrow(node, {
    id: newId(), fromNodeId: parentId, toNodeId: nodeId, kind: 'auto',
  });
  useGraphStore.getState().requestPanTo(nodeId, parentId, 'newNodes');
  return nodeId;
}

export const spawnFreeImageNode = spawnWikimediaImageNode;
