'use client';
import { memo, useId, useMemo, type CSSProperties } from 'react';
import type { Arrow, ImageQuestionContext } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useImageGeometryStore } from '@/store/useImageGeometryStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { imageArrowCandidates, imageArrowContext, imageMediaKey } from '@/lib/imageAtlas';
import { isArrowVisible } from '@/lib/arrowPolicy';
import { DEFAULT_PHYSICS_CONFIG } from '@/physics/defaults';
import { ImageArrowItem } from '@/components/canvas/ArrowLayer';
import { nodeWidth, nodeRenderedH } from '@/lib/nodeSize';

const AtlasInk = memo(function AtlasInk({ arrow, context, projectId, smoothing }: {
  arrow: Arrow; context: ImageQuestionContext; projectId: string; smoothing: number;
}) {
  const from = useGraphStore((s) => s.project?.nodes[arrow.fromNodeId]);
  const to = useGraphStore((s) => s.project?.nodes[arrow.toNodeId]);
  const visible = useGraphStore((s) => isArrowVisible(arrow, s.project?.selection ?? []));
  const highlighted = useGraphStore((s) => s.highlight?.arrowId === arrow.id && s.highlight.source !== 'node');
  if (!visible) return null;
  return <ImageArrowItem arrow={arrow} from={from} to={to} projectId={projectId}
    imageContext={context} ropeSmoothing={smoothing} isHighlighted={highlighted} overlayOnly />;
});

/** Duplicate ink over the source card: the bitmap layer fades on image hover;
 * the separate chrome layer crosses the header/footer below the action panels. */
export function ImageAtlasOverlay({ nodeId, style, chromeOnly = false }: { nodeId: string; style?: CSSProperties; chromeOnly?: boolean }) {
  const clipId = useId().replace(/:/g, '');
  const projectId = useGraphStore((s) => s.project?.id);
  const arrows = useGraphStore((s) => s.project ? imageArrowCandidates(s.project.arrows, nodeId) : undefined);
  const hasReferences = arrows?.some((a) => a.kind === 'dotted');
  const selection = useGraphStore((s) => hasReferences ? s.project?.selection : undefined);
  const node = useGraphStore((s) => s.project?.nodes[nodeId]);
  const geometry = useImageGeometryStore((s) => s.byNode[nodeId]);
  const livePosition = useLivePositionsStore((s) => s.positions[nodeId]);
  const smoothing = useSettingsStore((s) => s.physicsConfig?.ropeSmoothing ?? DEFAULT_PHYSICS_CONFIG.ropeSmoothing);
  const mediaKey = imageMediaKey(node?.versions[node.currentVersionIndex]?.media);
  const relations = useMemo(() => {
    if (!arrows || !mediaKey) return [];
    const nodes = useGraphStore.getState().project?.nodes;
    return arrows.filter((a) => isArrowVisible(a, selection ?? [])).flatMap((arrow) => {
      const context = imageArrowContext(arrow, nodes?.[arrow.toNodeId]);
      return context && nodes?.[arrow.toNodeId] && imageMediaKey(context.sourceMedia) === mediaKey ? [{ arrow, context }] : [];
    });
  }, [arrows, nodeId, mediaKey, selection]);
  if (!relations.length || !node || !projectId || geometry?.projectId !== projectId
    || geometry.mediaKey !== mediaKey || geometry.rect.width <= 0 || geometry.rect.height <= 0) return null;
  const position = livePosition ?? node.position;
  const rect = geometry.rect;
  const width = nodeWidth(node), height = nodeRenderedH(node);
  return <div className={chromeOnly ? 'image-atlas-chrome-layer' : 'image-atlas-layer'} style={style} aria-hidden="true"
    data-image-atlas={chromeOnly ? undefined : nodeId} data-image-atlas-chrome={chromeOnly ? nodeId : undefined}>
    <svg className="image-atlas-ink" viewBox={chromeOnly ? `${position.x} ${position.y} ${width} ${height}`
      : `${position.x + rect.x} ${position.y + rect.y} ${rect.width} ${rect.height}`}>
      {chromeOnly && <defs><clipPath id={clipId}><path clipRule="evenodd"
        d={`M${position.x},${position.y}h${width}v${height}h${-width}Z M${position.x + rect.x},${position.y + rect.y}h${rect.width}v${rect.height}h${-rect.width}Z`} /></clipPath></defs>}
      <g clipPath={chromeOnly ? `url(#${clipId})` : undefined}>
      {relations.map(({ arrow, context }) => <AtlasInk key={arrow.id} arrow={arrow} context={context} projectId={projectId} smoothing={smoothing} />)}
      </g>
    </svg>
  </div>;
}
