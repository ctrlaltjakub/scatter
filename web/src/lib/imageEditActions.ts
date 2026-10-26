/**
 * Image-editor save pipeline: persist a baked (flattened) image as a NEW
 * version of a media node. The untouched original stays one version back —
 * exactly the text editor's "save appends a version" semantics, and exactly
 * one app-level undo entry.
 *
 * Mirrors attachMediaFromFile (asset + URL cache first) and saveManualEdit
 * (single updateNode appending the version). The card keeps the width the
 * user chose — only the height re-derives for the new aspect (aspectResize),
 * so saving never snaps an enlarged node back to spawn size.
 */
import { useGraphStore } from '@/store/useGraphStore';
import { useMediaUrlStore } from '@/store/useMediaUrlStore';
import { newId } from './ids';
import { aspectResize } from './mediaSizing';
import { DEFAULT_NODE_W } from './nodeSize';
import { saveAsset, deleteAsset } from '@/opfs/assetsIO';
import type { HeaderParts, MediaRef, NodeVersion } from '@/store/types';
import { flattenHeaderParts, normalizeHeaderParts } from './nodeHeaderText';

/** GIFs are excluded from editing — the canvas would flatten the animation. */
export function isGifMedia(media: MediaRef): boolean {
  if (media.mime?.toLowerCase().split(';')[0] === 'image/gif') return true;
  return [media.url, media.fileName].some((name) => name?.split(/[?#]/)[0]!.toLowerCase().endsWith('.gif'));
}

export function isStillImageMedia(media: MediaRef | undefined): media is MediaRef {
  return isEditableImageMedia(media) && !isGifMedia(media);
}

/** A media ref the crop/annotate editor can open (GIF gating is separate). */
export function isEditableImageMedia(media: MediaRef | undefined): media is MediaRef {
  return !!media && media.kind === 'image' && media.source !== 'embed' && !media.unsupportedReason;
}

export async function saveEditedImage(
  nodeId: string,
  blob: Blob,
  dims: { width: number; height: number },
  editedHeader?: HeaderParts,
): Promise<void> {
  const g = useGraphStore.getState();
  const project = g.project;
  const node = project?.nodes[nodeId];
  if (!project || !node) return;
  const cur = node.versions[node.currentVersionIndex];
  if (!cur) return;

  // Bytes into OPFS + object URL into the runtime cache BEFORE the store
  // write, so the canvas can render the new version the instant it appears.
  const assetId = newId();
  await saveAsset(project.id, assetId, blob);
  const latest = useGraphStore.getState();
  const freshNode = latest.project?.nodes[nodeId];
  const freshVersion = freshNode?.versions[freshNode.currentVersionIndex];
  if (latest.project?.id !== project.id || !freshNode || freshNode.generating
    || freshNode.currentVersionIndex !== node.currentVersionIndex || freshVersion?.createdAt !== cur.createdAt
    || freshVersion?.media?.assetId !== cur.media?.assetId || freshVersion?.media?.url !== cur.media?.url) {
    await deleteAsset(project.id, assetId);
    throw new Error('The image or project changed while saving. Your edits were not applied to a different image.');
  }
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    useMediaUrlStore.getState().set(assetId, URL.createObjectURL(blob));
  }

  const media: MediaRef = {
    source: 'asset',
    kind: 'image',
    assetId,
    mime: blob.type || 'image/png',
    naturalWidth: dims.width,
    naturalHeight: dims.height,
    byteSize: blob.size,
    fileName: cur.media?.fileName,
    wikimedia: cur.media?.wikimedia
      ? { ...cur.media.wikimedia, modified: true }
      : undefined,
    freeImage: cur.media?.freeImage
      ? { ...cur.media.freeImage, modified: true }
      : undefined,
  };

  const headerParts = editedHeader ? normalizeHeaderParts(editedHeader) : cur.headerParts;
  const newVersion: NodeVersion = {
    header: headerParts ? flattenHeaderParts(headerParts) : cur.header,
    headerParts,
    body: '',
    createdAt: Date.now(),
    generatedBy: 'media',
    contentType: 'media',
    media,
    // Editing changes pixels, not provenance. Preserve this so the generated
    // badge and regenerate action remain truthful on the edited version.
    imageGeneration: cur.imageGeneration,
    ...aspectResize(dims.width, dims.height, cur.width ?? DEFAULT_NODE_W),
  };

  // ONE updateNode = one zundo entry: version list + pointer move together.
  const versions = [...freshNode.versions, newVersion];
  latest.updateNode(nodeId, { versions, currentVersionIndex: versions.length - 1 });
}

/** Save only an image editor title change while reusing the exact same media. */
export function saveMediaHeaderVersion(nodeId: string, editedHeader: HeaderParts): void {
  const graph = useGraphStore.getState();
  const node = graph.project?.nodes[nodeId];
  const cur = node?.versions[node.currentVersionIndex];
  if (!node || !cur?.media) return;
  const headerParts = normalizeHeaderParts(editedHeader);
  const version: NodeVersion = {
    ...cur,
    header: flattenHeaderParts(headerParts) || cur.header,
    headerParts,
    createdAt: Date.now(),
    generatedBy: 'manual',
  };
  const versions = [...node.versions, version];
  graph.updateNode(nodeId, { versions, currentVersionIndex: versions.length - 1 });
}
