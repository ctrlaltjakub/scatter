import type { Arrow, ImageQuestionContext, MediaRef, Project, ScatterNode } from '@/store/types';
import { imageRegionFrame } from './imageRegionFrame';

export interface ImageBitmapRect { x: number; y: number; width: number; height: number }

const frameCache = new WeakMap<ImageQuestionContext['regions'], WeakMap<ImageBitmapRect, ReturnType<typeof imageRegionFrame>>>();
export function imageAtlasFrame(context: ImageQuestionContext, rect: ImageBitmapRect) {
  let byRect = frameCache.get(context.regions);
  if (!byRect) { byRect = new WeakMap(); frameCache.set(context.regions, byRect); }
  if (!byRect.has(rect)) byRect.set(rect, imageRegionFrame(context.regions, rect));
  return byRect.get(rect)!;
}

const EMPTY_ARROWS: readonly Arrow[] = Object.freeze([]);
const candidatesBySource = new WeakMap<Project['arrows'], Map<string, Arrow[]>>();

/** Build once per immutable arrow map, not once per image on every focus change. */
export function imageArrowCandidates(arrows: Project['arrows'], nodeId: string): readonly Arrow[] {
  let index = candidatesBySource.get(arrows);
  if (!index) {
    index = new Map();
    for (const arrow of Object.values(arrows)) {
      if (!arrow.sourceImage && (arrow.kind !== 'auto' || arrow.label || arrow.sourceSelection || arrow.sourceAnswer)) continue;
      const list = index.get(arrow.fromNodeId) ?? [];
      list.push(arrow);
      index.set(arrow.fromNodeId, list);
    }
    candidatesBySource.set(arrows, index);
  }
  return index.get(nodeId) ?? EMPTY_ARROWS;
}

/** Pixel identity, independent of title/version changes that reuse the same image. */
export function imageMediaKey(media: MediaRef | undefined): string | null {
  if (!media || media.kind !== 'image' || media.unsupportedReason) return null;
  if (media.source === 'asset' && media.assetId) return `asset:${media.assetId}`;
  if (media.source === 'link' && media.url) return `link:${media.url}`;
  return null;
}

export function imageArrowContext(arrow: Arrow, child?: ScatterNode): ImageQuestionContext | undefined {
  if (arrow.sourceImage) return arrow.sourceImage.regions.length ? arrow.sourceImage : undefined;
  // Earlier image follow-ups already retained the exact image/regions on the
  // child. Read those without migrating projects or creating an undo entry.
  if (arrow.kind !== 'auto' || arrow.label || arrow.sourceSelection || arrow.sourceAnswer) return undefined;
  return child?.versions.find((version) => version.imageContext?.regions.length)?.imageContext;
}

export function imageContextMatches(context: ImageQuestionContext, node: ScatterNode): boolean {
  const key = imageMediaKey(context.sourceMedia);
  return !!key && key === imageMediaKey(node.versions[node.currentVersionIndex]?.media);
}
