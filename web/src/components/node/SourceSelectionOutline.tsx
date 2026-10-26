'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type RefObject,
} from 'react';

interface RelationOutlinePath {
  key: string;
  d: string;
  relationId: string;
}

interface OutlinePresentation {
  activePaths: RelationOutlinePath[];
  latentPaths: RelationOutlinePath[];
}

interface Props {
  rootRef: RefObject<HTMLDivElement | null>;
  /** Changes whenever React may have replaced or reflowed marked prose. */
  refreshKey: string;
}

interface RectBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function samePaths(a: RelationOutlinePath[], b: RelationOutlinePath[]): boolean {
  return a.length === b.length && a.every((path, index) => (
    path.key === b[index]?.key
    && path.d === b[index]?.d
    && path.relationId === b[index]?.relationId
  ));
}

function samePresentation(a: OutlinePresentation, b: OutlinePresentation): boolean {
  return samePaths(a.activePaths, b.activePaths)
    && samePaths(a.latentPaths, b.latentPaths);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Merge inline DOM fragments that occupy the same visual line. Bold runs,
 * chips, and React text spans can each contribute their own client rect; the
 * active outline must follow the visual line, not those implementation seams. */
function mergeVisualLineRects(rects: RectBox[]): RectBox[] {
  const lines: RectBox[] = [];
  const ordered = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  for (const rect of ordered) {
    const center = (rect.top + rect.bottom) / 2;
    const line = lines.find((candidate) => {
      const candidateCenter = (candidate.top + candidate.bottom) / 2;
      const candidateHeight = candidate.bottom - candidate.top;
      const rectHeight = rect.bottom - rect.top;
      return Math.abs(center - candidateCenter) <= Math.max(2, Math.min(candidateHeight, rectHeight) * 0.35);
    });
    if (!line) {
      lines.push({ ...rect });
      continue;
    }
    line.left = Math.min(line.left, rect.left);
    line.top = Math.min(line.top, rect.top);
    line.right = Math.max(line.right, rect.right);
    line.bottom = Math.max(line.bottom, rect.bottom);
  }
  return lines.sort((a, b) => a.top - b.top || a.left - b.left);
}

/** Add visual breathing room without altering the inline highlight fill. The
 * shared boundary between neighboring visual lines keeps the padded outline a
 * single, non-self-intersecting shape instead of overlapping rectangles. */
export function padConnectedLines(lines: RectBox[], padding = 2): RectBox[] {
  const padded = lines.map((line) => ({
    left: line.left - padding,
    top: line.top - padding,
    right: line.right + padding,
    bottom: line.bottom + padding,
  }));
  for (let index = 0; index < padded.length - 1; index += 1) {
    const current = padded[index]!;
    const next = padded[index + 1]!;
    const sourceCurrent = lines[index]!;
    const sourceNext = lines[index + 1]!;
    // A term at the right edge wrapping to the far left is two disconnected
    // fragments, not a passage spanning all the unrelated text between them.
    if (Math.min(sourceCurrent.right, sourceNext.right) <= Math.max(sourceCurrent.left, sourceNext.left)) continue;
    const sharedBoundary = (sourceCurrent.bottom + sourceNext.top) / 2;
    current.bottom = sharedBoundary;
    next.top = sharedBoundary;
  }
  return padded;
}

/** Trace one continuous orthogonal perimeter around a wrapped inline chunk.
 * Adjacent visual lines are joined at their changing left/right edges, so the
 * dark-mode resting mark reads as one passage rather than stacked rectangles. */
interface PathPoint {
  x: number;
  y: number;
}

function simplifyClosedPath(points: PathPoint[]): PathPoint[] {
  const unique = points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    return !previous || point.x !== previous.x || point.y !== previous.y;
  });
  return unique.filter((point, index) => {
    const previous = unique[(index - 1 + unique.length) % unique.length];
    const next = unique[(index + 1) % unique.length];
    if (!previous || !next) return true;
    return !(
      (previous.x === point.x && point.x === next.x)
      || (previous.y === point.y && point.y === next.y)
    );
  });
}

/** Overlapping lines share one rounded perimeter; disconnected line fragments
 * get separate closed paths. Explicit corner arcs remain visible even at a
 * one-pixel stroke width, unlike an SVG rounded stroke join alone. */
export function connectedChunkPath(lines: RectBox[], radius = 3): string {
  if (lines.length === 0) return '';
  const groups: RectBox[][] = [];
  for (const line of lines) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (!previous || Math.min(previous.right, line.right) <= Math.max(previous.left, line.left)) groups.push([line]);
    else group!.push(line);
  }
  if (groups.length > 1) return groups.map(group => connectedChunkPath(group, radius)).join(' ');
  const points: PathPoint[] = [];
  const first = lines[0]!;
  points.push(
    { x: first.left, y: first.top },
    { x: first.right, y: first.top },
  );
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    points.push({ x: line.right, y: line.bottom });
    const next = lines[index + 1];
    if (next) points.push(
      { x: next.right, y: line.bottom },
      { x: next.right, y: next.top },
    );
  }
  const last = lines.at(-1)!;
  points.push({ x: last.left, y: last.bottom });
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    points.push({ x: line.left, y: line.top });
    const previous = lines[index - 1];
    if (previous) points.push(
      { x: previous.left, y: line.top },
      { x: previous.left, y: previous.bottom },
    );
  }
  const polygon = simplifyClosedPath(points);
  if (polygon.length < 3) return '';
  const corners = polygon.map((point, index) => {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length]!;
    const next = polygon[(index + 1) % polygon.length]!;
    const incomingLength = Math.hypot(previous.x - point.x, previous.y - point.y);
    const outgoingLength = Math.hypot(next.x - point.x, next.y - point.y);
    const cornerRadius = Math.min(radius, incomingLength / 2, outgoingLength / 2);
    const start = {
      x: point.x + ((previous.x - point.x) / incomingLength) * cornerRadius,
      y: point.y + ((previous.y - point.y) / incomingLength) * cornerRadius,
    };
    const end = {
      x: point.x + ((next.x - point.x) / outgoingLength) * cornerRadius,
      y: point.y + ((next.y - point.y) / outgoingLength) * cornerRadius,
    };
    return { point, start, end };
  });
  const firstCorner = corners[0]!;
  const commands = [`M${rounded(firstCorner.start.x)} ${rounded(firstCorner.start.y)}`];
  for (const corner of corners) {
    if (corner !== firstCorner) {
      commands.push(`L${rounded(corner.start.x)} ${rounded(corner.start.y)}`);
    }
    commands.push(
      `Q${rounded(corner.point.x)} ${rounded(corner.point.y)} ${rounded(corner.end.x)} ${rounded(corner.end.y)}`,
    );
  }
  commands.push('Z');
  return commands.join(' ');
}

function rectsWithinRoot(root: HTMLDivElement, element: HTMLElement): RectBox[] {
  const rootRect = root.getBoundingClientRect();
  const layoutWidth = root.offsetWidth || rootRect.width || 1;
  const layoutHeight = root.offsetHeight || rootRect.height || 1;
  const scaleX = rootRect.width > 0 ? rootRect.width / layoutWidth : 1;
  const scaleY = rootRect.height > 0 ? rootRect.height / layoutHeight : scaleX;
  return Array.from(element.getClientRects()).flatMap((rect) => (
    rect.width <= 0 || rect.height <= 0 ? [] : [{
      left: (rect.left - rootRect.left) / scaleX,
      top: (rect.top - rootRect.top) / scaleY,
      right: (rect.right - rootRect.left) / scaleX,
      bottom: (rect.bottom - rootRect.top) / scaleY,
    }]
  ));
}

function measureOutlines(root: HTMLDivElement): OutlinePresentation {
  const marks = [...root.querySelectorAll<HTMLElement>('.source-selection-mark.active')]
    .filter((mark) => !mark.closest('.sc-ab-measure, [aria-hidden="true"]'));

  const segments: Array<{ arrowId: string; rects: RectBox[] }> = [];
  let current: { arrowId: string; rects: RectBox[] } | null = null;
  const finish = () => {
    if (current?.rects.length) segments.push(current);
    current = null;
  };

  for (const mark of marks) {
    const arrowId = mark.dataset.arrowId ?? '';
    if (
      !current
      || current.arrowId !== arrowId
      || mark.classList.contains('source-selection-mark--start')
    ) {
      finish();
      current = { arrowId, rects: [] };
    }
    current.rects.push(...rectsWithinRoot(root, mark));
    if (mark.classList.contains('source-selection-mark--end')) finish();
  }
  finish();

  const activePaths: RelationOutlinePath[] = [];
  segments.forEach((segment, segmentIndex) => {
    const d = connectedChunkPath(
      padConnectedLines(mergeVisualLineRects(segment.rects)),
      4,
    );
    if (d) activePaths.push({
      key: `selection-${segment.arrowId}-${segmentIndex}`,
      relationId: segment.arrowId,
      d,
    });
  });

  const activeTerms = [...root.querySelectorAll<HTMLElement>('.ref-chip.active')]
    .filter((mark) => !mark.closest('.sc-ab-measure, [aria-hidden="true"]'));
  activeTerms.forEach((term, index) => {
    const d = connectedChunkPath(
      padConnectedLines(mergeVisualLineRects(rectsWithinRoot(root, term))),
      4,
    );
    if (d) activePaths.push({
      key: `term-${term.dataset.relationChildId ?? term.dataset.referenceTerm ?? index}-${index}`,
      relationId: term.dataset.relationChildId ?? term.dataset.referenceTerm ?? String(index),
      d,
    });
  });

  const latentPaths: RelationOutlinePath[] = [];
  // The connected resting perimeter is a dark-mode treatment. Avoid scanning
  // every explored relation in light mode, where the SVG stroke is absent.
  if (document.documentElement.dataset.theme !== 'mocha') {
    return { activePaths, latentPaths };
  }
  const latentMarks = [...root.querySelectorAll<HTMLElement>('.source-selection-mark.explored')]
    .filter((mark) => !mark.closest('.sc-ab-measure, [aria-hidden="true"]'));
  const latentSegments: Array<{ arrowId: string; rects: RectBox[] }> = [];
  let latentCurrent: { arrowId: string; rects: RectBox[] } | null = null;
  const finishLatent = () => {
    if (latentCurrent?.rects.length) latentSegments.push(latentCurrent);
    latentCurrent = null;
  };
  for (const mark of latentMarks) {
    const arrowId = mark.dataset.arrowId ?? '';
    if (
      !latentCurrent
      || latentCurrent.arrowId !== arrowId
      || mark.classList.contains('source-selection-mark--start')
    ) {
      finishLatent();
      latentCurrent = { arrowId, rects: [] };
    }
    latentCurrent.rects.push(...rectsWithinRoot(root, mark));
    if (mark.classList.contains('source-selection-mark--end')) finishLatent();
  }
  finishLatent();
  latentSegments.forEach((segment, index) => {
    const d = connectedChunkPath(
      padConnectedLines(mergeVisualLineRects(segment.rects)),
      4,
    );
    if (d) latentPaths.push({
      key: `selection-${segment.arrowId}-${index}`,
      relationId: segment.arrowId,
      d,
    });
  });

  // Explored term chips can wrap too. Use the same joined perimeter rather
  // than CSS box-decoration cloning a new border for every visual line.
  const exploredTerms = [...root.querySelectorAll<HTMLElement>('.ref-chip.explored')]
    .filter((mark) => !mark.closest('.sc-ab-measure, [aria-hidden="true"]'));
  exploredTerms.forEach((term, index) => {
    const d = connectedChunkPath(
      padConnectedLines(mergeVisualLineRects(rectsWithinRoot(root, term))),
      4,
    );
    if (d) latentPaths.push({
      key: `term-${term.dataset.relationChildId ?? term.dataset.referenceTerm ?? index}-${index}`,
      relationId: term.dataset.relationChildId ?? term.dataset.referenceTerm ?? String(index),
      d,
    });
  });

  return { activePaths, latentPaths };
}

/** Layout-only relation outlines. Resting dark-mode and active cross-theme
 * borders share one padded, connected SVG geometry. */
export function SourceSelectionOutline({ rootRef, refreshKey }: Props) {
  const [presentation, setPresentation] = useState<OutlinePresentation>({
    activePaths: [],
    latentPaths: [],
  });
  const measure = useCallback(() => {
    const root = rootRef.current;
    const next = root ? measureOutlines(root) : { activePaths: [], latentPaths: [] };
    setPresentation((previous) => samePresentation(previous, next) ? previous : next);
  }, [rootRef]);

  useLayoutEffect(() => {
    measure();
  }, [measure, refreshKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;
    const remeasure = () => {
      if (!disposed) measure();
    };
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (
        event.propertyName === 'font-weight'
        && event.target instanceof Element
        && event.target.classList.contains('source-selection-mark')
      ) remeasure();
    };
    const observer = new ResizeObserver(remeasure);
    observer.observe(root);
    const classObserver = new MutationObserver(remeasure);
    classObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
    const themeObserver = new MutationObserver(remeasure);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    window.addEventListener('resize', remeasure);
    root.addEventListener('transitionend', handleTransitionEnd);
    void document.fonts?.ready.then(remeasure);
    return () => {
      disposed = true;
      observer.disconnect();
      classObserver.disconnect();
      themeObserver.disconnect();
      window.removeEventListener('resize', remeasure);
      root.removeEventListener('transitionend', handleTransitionEnd);
    };
  }, [measure, rootRef]);

  if (presentation.activePaths.length === 0 && presentation.latentPaths.length === 0) return null;
  return (
    <div className="source-selection-outline-layer" aria-hidden="true">
      {presentation.latentPaths.length > 0 && (
        <svg className="relation-latent-outline-svg">
          {presentation.latentPaths.map((path) => (
            <path key={path.key} className="relation-latent-outline" d={path.d} />
          ))}
        </svg>
      )}
      {presentation.activePaths.length > 0 && (
        <svg className="relation-latent-outline-svg">
          {presentation.activePaths.flatMap((path) => [
            <path
              key={`${path.key}-pulse`}
              className="relation-active-outline-pulse"
              d={path.d}
            />,
            <path
              key={path.key}
              className="relation-active-outline"
              data-source-selection-outline={path.relationId}
              d={path.d}
            />,
          ])}
        </svg>
      )}
    </div>
  );
}
