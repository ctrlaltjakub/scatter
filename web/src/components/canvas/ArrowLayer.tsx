'use client';
import React, { memo, useId, useRef, useSyncExternalStore } from 'react';
import type { Project, Arrow, ScatterNode, ImageQuestionContext } from '@/store/types';
import { nodeWidth, nodeRenderedH } from '@/lib/nodeSize';
import { useArrowAnchorsStore } from '@/store/useArrowAnchorsStore';
import { useGraphStore } from '@/store/useGraphStore';
import { birthIsPending, useNodeBirthStore } from '@/store/useNodeBirthStore';
import { useNodeEntranceStyle } from '@/lib/nodeEntrance';
import { useSettingsStore } from '@/store/useSettingsStore';
import { rectBorderToward } from '@/physics/verletRope';
import { DEFAULT_PHYSICS_CONFIG } from '@/physics/defaults';
import { resolveArrowLabelEnd } from '@/lib/arrowNav';
import { isNodeFullyVisible, isNodePartiallyVisible } from '@/lib/nodeVisibility';
import { mutedAccentHex } from '@/lib/groupColor';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';
import { isArrowVisible } from '@/lib/arrowPolicy';
import { revealRelationSource } from '@/lib/relationNavigation';
import { imageArrowContext, imageAtlasFrame, imageContextMatches, imageMediaKey } from '@/lib/imageAtlas';
import { sourcePortCenter, sourcePortToward, type SourcePort } from '@/physics/sourcePort';
import { useImageGeometryStore } from '@/store/useImageGeometryStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';

const DOTTED_ARROW_DASHARRAY = '4 12';
const ARROW_STROKE_TRANSITION = {
  transition: 'stroke 0.12s, stroke-width 0.12s, stroke-opacity 0.12s',
};

/** PERF R7: value-equality comparator for an anchor chain. Returns
 *  true when each point pair is within 0.01 px — matches the
 *  dead-zone the live-positions store uses. Lets per-arrow chain
 *  subscribers bail out when the worker emitted a tick but THIS arrow's
 *  chain didn't move (common after the broad-phase emit gate already
 *  decided "something changed", but it was another arrow). */
function chainsEqual(
  a: { x: number; y: number }[] | undefined,
  b: { x: number; y: number }[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]!, pb = b[i]!;
    if (Math.abs(pa.x - pb.x) > 0.01 || Math.abs(pa.y - pb.y) > 0.01) return false;
  }
  return true;
}

/** PERF R7: per-arrow chain subscription with value equality.
 *  zustand v5 dropped the equalityFn overload on the bound store hook,
 *  and adding `use-sync-external-store` as a new dep just to import
 *  `zustand/traditional` is overkill. We get the same behaviour by
 *  using React's own `useSyncExternalStore`: the snapshot function
 *  returns a STABLE reference when the chain hasn't moved by more
 *  than 0.01 px on any point, so React skips the re-render. */
function useArrowChain(arrowId: string): { x: number; y: number }[] | undefined {
  const lastRef = useRef<{ x: number; y: number }[] | undefined>(undefined);
  return useSyncExternalStore(
    useArrowAnchorsStore.subscribe,
    () => {
      const next = useArrowAnchorsStore.getState().anchors[arrowId];
      if (chainsEqual(lastRef.current, next)) return lastRef.current;
      lastRef.current = next;
      return next;
    },
    // No SSR rendering of arrows — the canvas is client-only.
    () => undefined,
  );
}

interface Props {
  project: Project;
}

/**
 * Build a smooth cubic-Bezier path through the given polyline points using
 * "constrained-length" smoothing.
 *
 * The tangent at each interior point is the unit vector from the previous
 * neighbor to the next neighbor (a centripetal-Catmull-Rom-flavored direction
 * estimate). The control point distance is `min(prevSegLen, nextSegLen) *
 * smoothing` — bounded by the SHORTER adjacent segment, which guarantees
 * the curve never overshoots the polyline.
 *
 * `smoothing` ∈ [0, 0.5]: 0 ⇒ polyline, 0.25 ≈ natural smooth, 0.4+ puffy.
 */
function smoothPath(pts: { x: number; y: number }[], smoothing: number): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) {
    return `M ${pts[0]!.x} ${pts[0]!.y} L ${pts[1]!.x} ${pts[1]!.y}`;
  }

  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;

  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p0 = i > 0 ? pts[i - 1]! : p1;
    const p3 = i + 2 < pts.length ? pts[i + 2]! : p2;

    const len01 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const len12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const len23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);

    let c1x: number;
    let c1y: number;
    if (len12 < 1e-9) {
      c1x = p1.x; c1y = p1.y;
    } else if (len01 < 1e-9) {
      c1x = p1.x + (p2.x - p1.x) * smoothing;
      c1y = p1.y + (p2.y - p1.y) * smoothing;
    } else {
      const tx = p2.x - p0.x;
      const ty = p2.y - p0.y;
      const tn = Math.hypot(tx, ty);
      const ctrlLen = Math.min(len01, len12) * smoothing;
      c1x = p1.x + (tx / tn) * ctrlLen;
      c1y = p1.y + (ty / tn) * ctrlLen;
    }

    let c2x: number;
    let c2y: number;
    if (len12 < 1e-9) {
      c2x = p2.x; c2y = p2.y;
    } else if (len23 < 1e-9) {
      c2x = p2.x - (p2.x - p1.x) * smoothing;
      c2y = p2.y - (p2.y - p1.y) * smoothing;
    } else {
      const tx = p3.x - p1.x;
      const ty = p3.y - p1.y;
      const tn = Math.hypot(tx, ty);
      const ctrlLen = Math.min(len12, len23) * smoothing;
      c2x = p2.x - (tx / tn) * ctrlLen;
      c2y = p2.y - (ty / tn) * ctrlLen;
    }

    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

export function ArrowLayer({ project }: Props) {
  const arrows = Object.values(project.arrows).filter((arrow) => isArrowVisible(arrow, project.selection));
  const ropeSmoothing = useSettingsStore(
    (s) => s.physicsConfig?.ropeSmoothing ?? DEFAULT_PHYSICS_CONFIG.ropeSmoothing,
  );
  // Only chip-sourced flashes light the arrow; clicking the child node itself
  // (source:'node') leaves the arrow alone.
  const highlightedArrowId = useGraphStore((s) =>
    s.highlight && s.highlight.source !== 'node' ? s.highlight.arrowId : undefined,
  );

  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
      <defs>
        {/* Arrowheads inherit the shaft's stroke (the origin node's group accent)
            via `context-stroke`, so one marker serves every arrow colour. */}
        <marker id="sc-arrowhead-auto" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
        <marker id="sc-arrowhead-dotted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
        {/* R6.8 — highlight head is +30% (6 → 7.8), not the old ~+17%. */}
        <marker id="sc-arrowhead-highlight" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7.8" markerHeight="7.8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(var(--ctp-text))" />
        </marker>
      </defs>
      {arrows.map((a) => {
        const from = project.nodes[a.fromNodeId];
        const context = from?.versions[from.currentVersionIndex]?.media?.kind === 'image'
          ? imageArrowContext(a, project.nodes[a.toNodeId]) : undefined;
        const Item = context ? ImageArrowItem : ArrowItem;
        return <Item
          key={a.id}
          projectId={project.id}
          imageContext={context}
          arrow={a}
          from={from}
          to={project.nodes[a.toNodeId]}
          ropeSmoothing={ropeSmoothing}
          isHighlighted={a.id === highlightedArrowId}
        />;
      })}
    </svg>
  );
}

interface ArrowItemProps {
  arrow: Arrow;
  from: ScatterNode | undefined;
  to: ScatterNode | undefined;
  ropeSmoothing: number;
  isHighlighted: boolean;
  imageSource?: { port: SourcePort; framePath: string; connectionPath: string; rect: { x: number; y: number; width: number; height: number }; clipId: string };
  overlayOnly?: boolean;
}

/** Only image-origin relations subscribe to bitmap layout and source motion.
 * Ordinary arrows retain exactly their original subscriptions and rope path. */
export const ImageArrowItem = memo(function ImageArrowItem(p: ArrowItemProps & {
  projectId: string;
  imageContext?: ImageQuestionContext;
}) {
  const geometry = useImageGeometryStore((s) => s.byNode[p.arrow.fromNodeId]);
  const position = useLivePositionsStore((s) => s.positions[p.arrow.fromNodeId]);
  const clipId = useId().replace(/:/g, '');
  const context = p.imageContext;
  const valid = !!context && !!p.from && imageContextMatches(context, p.from)
    && geometry?.projectId === p.projectId && geometry.mediaKey === imageMediaKey(context.sourceMedia);
  const frame = valid ? imageAtlasFrame(context, geometry.rect) : null;
  if (p.overlayOnly && !frame) return null;
  const source = frame && p.from ? { port: frame.port, framePath: frame.path, connectionPath: frame.connectionPath, clipId,
    rect: { ...(position ?? p.from.position), width: nodeWidth(p.from), height: nodeRenderedH(p.from) } } : undefined;
  return <ArrowItem {...p} imageSource={source} />;
});

/**
 * PERF R7: one ArrowItem per arrow, memoized. Per-arrow chain
 * subscription with value-equality so a worker tick that only moved
 * other arrows doesn't re-render us. The custom memo also bails when
 * `arrow`, `from`, `to`, and visual-state flags didn't change.
 */
const ArrowItem = memo(function ArrowItem(p: ArrowItemProps) {
  const a = p.arrow;
  const fromBirth = useNodeBirthStore(s => s.byNode[a.fromNodeId]);
  const toBirth = useNodeBirthStore(s => s.byNode[a.toNodeId]);
  const birth = birthIsPending(fromBirth) ? fromBirth : toBirth ?? fromBirth;
  const entranceStyle = useNodeEntranceStyle(birth);
  // PERF R7: only fire this subscription when THIS arrow's chain
  // actually changes (≥ 0.01 px on any point) — see chainsEqual.
  const chain = useArrowChain(a.id);
  // Arrow ink follows the ORIGIN node's group: a muted (slightly darker, less
  // saturated) version of the group color; ungrouped origins use the project
  // base color (neutral grey only on legacy color-less data).
  const fromGroupColor = useGraphStore((s) => {
    const gid = s.project?.nodes[a.fromNodeId]?.groupId;
    return (gid ? s.project?.groups[gid]?.color : undefined) ?? s.project?.color ?? null;
  });
  const accentHueShift = useSettingsStore((s) => s.accentHueShift);
  const accentDesaturate = useSettingsStore((s) => s.accentDesaturate);
  const accentDarken = useSettingsStore((s) => s.accentDarken);
  const resolvedTheme = useResolvedTheme();
  const { from, to, ropeSmoothing } = p;
  return ((): React.ReactElement | null => {
    const fromNode = from;
    const toNode = to;
    if (!fromNode || !toNode) return null;
    const fromW = nodeWidth(fromNode);
    const toW = nodeWidth(toNode);
    const fromH = nodeRenderedH(fromNode);
    const toH = nodeRenderedH(toNode);

    let points: { x: number; y: number }[];
    if (chain && chain.length >= 2) {
      points = chain;
    } else if (a.anchors && a.anchors.length >= 2) {
      points = a.anchors;
    } else {
      const fromRect = { x: fromNode.position.x, y: fromNode.position.y, width: fromW, height: fromH };
      const toRect = { x: toNode.position.x, y: toNode.position.y, width: toW, height: toH };
      const fromCenter = { x: fromNode.position.x + fromW / 2, y: fromNode.position.y + fromH / 2 };
      const toCenter = { x: toNode.position.x + toW / 2, y: toNode.position.y + toH / 2 };
      points = [
        rectBorderToward(fromRect, toCenter),
        rectBorderToward(toRect, fromCenter),
      ];
    }
    if (p.imageSource && !chain) {
      // Before the worker's first image route, draw a genuine region-to-target
      // line. Never prepend a fake lead-in to an old node-border route.
      const { port, rect } = p.imageSource;
      const target = { ...toNode.position, width: toW, height: toH };
      const center = sourcePortCenter(port, rect, { x: target.x + toW / 2, y: target.y + toH / 2 });
      points = [sourcePortToward(port, rect, { x: target.x + toW / 2, y: target.y + toH / 2 }), rectBorderToward(target, center)];
    }
    const d = smoothPath(points, ropeSmoothing);
    const imageRect = p.imageSource?.rect;
    const clipId = p.imageSource?.clipId;
    const extent = imageRect ? points.reduce((r, point) => ({
      left: Math.min(r.left, point.x - 100), top: Math.min(r.top, point.y - 100),
      right: Math.max(r.right, point.x + 100), bottom: Math.max(r.bottom, point.y + 100),
    }), { left: imageRect.x - 100, top: imageRect.y - 100,
      right: imageRect.x + imageRect.width + 100, bottom: imageRect.y + imageRect.height + 100 }) : null;

    const isHighlighted = p.isHighlighted;
    const stroke = isHighlighted ? 'rgb(var(--ctp-text))' : mutedAccentHex(
      fromGroupColor,
      accentHueShift,
      accentDesaturate,
      accentDarken,
      resolvedTheme,
      0.58,
    );
    // The region frame and both copies of its arrow share the exact same ink,
    // including theme/group colors and transient highlight emphasis.
    const ink = {
      fill: 'none',
      stroke,
      strokeOpacity: isHighlighted || resolvedTheme === 'dark' ? 1 : 0.9,
      strokeWidth: isHighlighted ? 3.9 : 3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: isHighlighted ? 'sc-arrow-shaft-pulse' : undefined,
      style: ARROW_STROKE_TRANSITION,
      pointerEvents: 'none',
    } as const;
    const markerId = isHighlighted
      ? 'sc-arrowhead-highlight'
      : a.kind === 'dotted' ? 'sc-arrowhead-dotted' : 'sc-arrowhead-auto';

    // Click the arrow to navigate to the end whose name the ASCII label would
    // show. This same rule applies even when no label found enough room to draw.
    const onHitClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      const store = useGraphStore.getState();
      const proj = store.project;
      if (!proj) return;
      const end = resolveArrowLabelEnd({
        childFullyVisible: isNodeFullyVisible(toNode),
        parentPartiallyVisible: isNodePartiallyVisible(fromNode),
      });
      const targetId = end === 'parent' ? fromNode.id : toNode.id;
      revealRelationSource(a);
      store.setSelection([targetId]);
      store.requestPanTo(targetId);
    };

    // R6.8 — the visible shaft stays a pure visual (no hover target).
    // Shafts and stroke-relative marker heads are both 20% larger. The existing
    // additional 30% active emphasis is retained (3 → 3.9).
    // The `sc-arrow-shaft-pulse` class (globals.css) plays a brief
    // swell-and-settle on highlight so the emphasis reads as a pulse,
    // not a slow fade; the fast inline transition eases it back out.
    return (
      <g data-arrow-entrance={a.id} style={entranceStyle}>
        {imageRect && extent && !p.overlayOnly && <defs>
          <clipPath id={`${clipId}-outside`}><path clipRule="evenodd" d={`M${extent.left},${extent.top}H${extent.right}V${extent.bottom}H${extent.left}Z M${imageRect.x},${imageRect.y}h${imageRect.width}v${imageRect.height}h${-imageRect.width}Z`} /></clipPath>
          <clipPath id={`${clipId}-inside`}><rect {...imageRect} /></clipPath>
        </defs>}
        {p.overlayOnly && p.imageSource && <g data-image-atlas-selection="">
          {/* Keep selection ink separate from the shaft: its outer half can
              cross the bitmap edge into the chrome layer and must fade too. */}
          <path
            {...ink}
            data-image-atlas-frame={a.id}
            d={p.imageSource.framePath}
            transform={`translate(${p.imageSource.rect.x} ${p.imageSource.rect.y})`}
            strokeDasharray={DOTTED_ARROW_DASHARRAY}
          />
          {p.imageSource.connectionPath && <path
            {...ink}
            data-image-region-connectors={a.id}
            d={p.imageSource.connectionPath}
            transform={`translate(${p.imageSource.rect.x} ${p.imageSource.rect.y})`}
            strokeDasharray={DOTTED_ARROW_DASHARRAY}
          />}
        </g>}
        <path
          {...ink}
          data-arrow-id={a.id}
          data-image-origin={p.imageSource ? '' : undefined}
          d={d}
          strokeDasharray={p.overlayOnly || a.kind === 'dotted' ? DOTTED_ARROW_DASHARRAY : undefined}
          clipPath={imageRect && !p.overlayOnly ? `url(#${clipId}-outside)` : undefined}
          markerEnd={p.overlayOnly ? undefined : `url(#${markerId})`}
        />
        {imageRect && !p.overlayOnly && <path {...ink} data-image-arrow-interior={a.id} d={d}
          strokeDasharray={DOTTED_ARROW_DASHARRAY} clipPath={`url(#${clipId}-inside)`} />}
        {/* Transparent wide hit target — makes the arrow clickable without
            changing its look. The explicit pointer-events overrides the
            <svg>'s inherited pointer-events:none, so ONLY this strip is
            interactive. It sits UNDER the node cards in z-order, so the
            clickable region is the open stretch of arrow between the two
            nodes (where a card doesn't cover it). */}
        {!p.overlayOnly && <path
          className="sc-arrow-hit"
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={32}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="stroke"
          style={{ cursor: 'var(--cur-click)' }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onHitClick}
        />}
      </g>
    );
  })();
});
