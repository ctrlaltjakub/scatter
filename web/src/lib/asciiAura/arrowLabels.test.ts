import { describe, it, expect } from 'vitest';
import {
  sanitizeHeader,
  chooseHeader,
  midpointAndDir,
  classifyOrientation,
  layoutLabelBox,
  segIntersectsRect,
  buildLabelCells,
  cellAccent,
  labelWrapCandidates,
  computeArrowLabels,
  nodeArrowLabelHeader,
  clipVisibleSpan,
  longestOnScreenRun,
  LABEL_MAX_LINES,
  type AuraOwner,
  type ArrowLabelInput,
} from './arrowLabels';
import { statusGlyphIndex } from './statusText';
import { appendChatAnswer, createChatNode } from '@/lib/chat/model';
import type { ScatterNode } from '@/store/types';

describe('nodeArrowLabelHeader', () => {
  const chat = () => appendChatAnswer(createChatNode({
    id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300,
  }), { turnId: 'first', createdAt: 2, question: 'How does memory work?' });

  it('uses the first prompt before a title is generated, even on a later answer', () => {
    const node = appendChatAnswer(chat(), { turnId: 'second', createdAt: 3, question: 'Give me an example.' });
    expect(node.versions[node.currentVersionIndex]?.header).toBe('Give me an example.');
    expect(nodeArrowLabelHeader(node)).toBe('How does memory work?');
  });

  it.each([false, true])('uses the conversation title across answer selections (manual=%s)', (titleManual) => {
    const node = appendChatAnswer(chat(), { turnId: 'second', createdAt: 3, question: 'Give me an example.' });
    node.chat = { ...node.chat!, title: 'Memory systems', titleManual };
    for (const currentVersionIndex of [0, 1, 2]) {
      expect(nodeArrowLabelHeader({ ...node, currentVersionIndex })).toBe('Memory systems');
    }
  });

  it('recovers the first prompt if the saved conversation title is blank', () => {
    const node = appendChatAnswer(chat(), { turnId: 'second', createdAt: 3, question: 'Give me an example.' });
    node.chat = { ...node.chat!, title: '  ' };
    expect(nodeArrowLabelHeader(node)).toBe('How does memory work?');
  });

  it('leaves untitled empty chats and missing nodes safe to display', () => {
    const node = createChatNode({ id: 'empty', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    expect(nodeArrowLabelHeader(node)).toBe('Chat');
    expect(nodeArrowLabelHeader(undefined)).toBe('');
  });

  it('preserves ordinary headers, standalone answer headers, and pending image titles', () => {
    const base = chat();
    const node: ScatterNode = { ...base, chat: undefined, type: 'follow-up' };
    node.versions[1] = { ...node.versions[1]!, contentType: 'answer', header: 'A standalone answer' };
    expect(nodeArrowLabelHeader(node)).toBe('A standalone answer');
    node.versions[1] = { ...node.versions[1]!, contentType: 'encyclopedic', chat: undefined, header: 'Memory' };
    expect(nodeArrowLabelHeader(node)).toBe('Memory');
    node.versions[1] = { ...node.versions[1]!, imageTitleState: 'pending' };
    expect(nodeArrowLabelHeader(node)).toBe('Generating...');
    expect(nodeArrowLabelHeader({ ...node, generating: false })).toBe('Memory');
  });
});

describe('sanitizeHeader', () => {
  it('uppercases and collapses whitespace', () => {
    expect(sanitizeHeader('  Light   reactions\n')).toBe('LIGHT REACTIONS');
  });
  it('returns empty for blank input', () => {
    expect(sanitizeHeader('   ')).toBe('');
  });
});

describe('chooseHeader', () => {
  it('defaults to the child header', () => {
    expect(chooseHeader({ childHeader: 'Child', parentHeader: 'Parent', childFullyVisible: false, parentPartiallyVisible: true })).toBe('CHILD');
  });
  it('uses the parent header when the child is fully visible and the parent is off-screen', () => {
    expect(chooseHeader({ childHeader: 'Child', parentHeader: 'Parent', childFullyVisible: true, parentPartiallyVisible: false })).toBe('PARENT');
  });
  it('keeps the child header when the child is fully visible but the parent is still partly on-screen', () => {
    expect(chooseHeader({ childHeader: 'Child', parentHeader: 'Parent', childFullyVisible: true, parentPartiallyVisible: true })).toBe('CHILD');
  });
  it('returns null when the chosen header is empty', () => {
    expect(chooseHeader({ childHeader: '', parentHeader: 'Parent', childFullyVisible: false, parentPartiallyVisible: true })).toBeNull();
  });
});

describe('midpointAndDir', () => {
  it('finds the centre + direction of a straight horizontal line', () => {
    const m = midpointAndDir([{ x: 0, y: 0 }, { x: 100, y: 0 }])!;
    expect(m.x).toBeCloseTo(50);
    expect(m.y).toBeCloseTo(0);
    expect(m.dirX).toBeCloseTo(1);
    expect(m.dirY).toBeCloseTo(0);
  });
  it('finds the centre + direction of a straight vertical line', () => {
    const m = midpointAndDir([{ x: 0, y: 0 }, { x: 0, y: 100 }])!;
    expect(m.x).toBeCloseTo(0);
    expect(m.y).toBeCloseTo(50);
    expect(m.dirX).toBeCloseTo(0);
    expect(m.dirY).toBeCloseTo(1);
  });
  it('walks arc-length on a multi-segment polyline', () => {
    // L-shape: (0,0)->(0,10)->(10,10), total len 20, half=10 lands on the first corner.
    const m = midpointAndDir([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }])!;
    expect(m.x).toBeCloseTo(0);
    expect(m.y).toBeCloseTo(10);
  });
  it('returns null for an empty polyline', () => {
    expect(midpointAndDir([])).toBeNull();
  });
});

describe('classifyOrientation', () => {
  it('is horizontal when |dx| >= |dy|', () => {
    expect(classifyOrientation(1, 0)).toBe('horizontal');
    expect(classifyOrientation(0.8, 0.6)).toBe('horizontal');
  });
  it('is vertical when |dy| > |dx|', () => {
    expect(classifyOrientation(0, 1)).toBe('vertical');
    expect(classifyOrientation(0.6, 0.8)).toBe('vertical');
  });
});

describe('layoutLabelBox', () => {
  const base = { boxW: 90, boxH: 18, screenW: 1000, screenH: 800, gapPx: 10 };

  it('places a horizontal label ABOVE the anchor by default', () => {
    const r = layoutLabelBox({ anchor: { x: 500, y: 400 }, dirX: 1, dirY: 0, reserved: [], ...base })!;
    expect(r.side).toBe('above');
    expect(r.x).toBeCloseTo(500 - 90 / 2);
    expect(r.y).toBeCloseTo(400 - 10 - 18);
  });

  it('flips a horizontal label BELOW when the above slot is taken', () => {
    const reserved = [{ x: 500 - 90 / 2, y: 400 - 10 - 18, w: 90, h: 18 }]; // exactly the above box
    const r = layoutLabelBox({ anchor: { x: 500, y: 400 }, dirX: 1, dirY: 0, reserved, ...base })!;
    expect(r.side).toBe('below');
    expect(r.y).toBeCloseTo(400 + 10);
  });

  it('places a vertical label to the RIGHT, then LEFT when blocked', () => {
    const right = layoutLabelBox({ anchor: { x: 500, y: 400 }, dirX: 0, dirY: 1, reserved: [], ...base })!;
    expect(right.side).toBe('right');
    const reservedRight = [{ x: 500 + 10, y: 400 - 18 / 2, w: 90, h: 18 }];
    const left = layoutLabelBox({ anchor: { x: 500, y: 400 }, dirX: 0, dirY: 1, reserved: reservedRight, ...base })!;
    expect(left.side).toBe('left');
  });

  it('returns null when neither side fits', () => {
    const reserved = [
      { x: 500 - 90 / 2, y: 400 - 10 - 18, w: 90, h: 18 },
      { x: 500 - 90 / 2, y: 400 + 10, w: 90, h: 18 },
    ];
    expect(layoutLabelBox({ anchor: { x: 500, y: 400 }, dirX: 1, dirY: 0, reserved, ...base })).toBeNull();
  });

  it('returns null when the box would clip off the screen edge', () => {
    const r = layoutLabelBox({ anchor: { x: 500, y: 5 }, dirX: 1, dirY: 0, reserved: [], ...base });
    // above clips the top (y negative); below at y=15 fits → not null, side below
    expect(r?.side).toBe('below');
  });

  it('flips below when an arrow segment crosses the above box', () => {
    // above box ≈ x[455,545] y[372,390]; a segment at y=380 cuts through it.
    const segments = [{ x1: 455, y1: 380, x2: 545, y2: 380 }];
    const r = layoutLabelBox({ anchor: { x: 500, y: 400 }, dirX: 1, dirY: 0, reserved: [], segments, ...base })!;
    expect(r.side).toBe('below');
  });

  it('keeps above when the only arrow runs clear of the box (the own arrow below it)', () => {
    const segments = [{ x1: 0, y1: 400, x2: 1000, y2: 400 }];
    const r = layoutLabelBox({ anchor: { x: 500, y: 400 }, dirX: 1, dirY: 0, reserved: [], segments, ...base })!;
    expect(r.side).toBe('above');
  });

  it('places a label on a DIAGONAL arrow without the line cutting through it', () => {
    // 45° arrow through the anchor (up-right). A straight up/down box would be
    // sliced by the line — the perpendicular offset must keep it fully clear.
    const seg = { x1: 400, y1: 500, x2: 600, y2: 300 }; // passes through (500,400)
    const r = layoutLabelBox({
      anchor: { x: 500, y: 400 }, dirX: Math.SQRT1_2, dirY: -Math.SQRT1_2,
      reserved: [], segments: [seg], ...base,
    });
    expect(r).not.toBeNull();
    const box = { x: r!.x, y: r!.y, w: base.boxW, h: base.boxH };
    expect(segIntersectsRect(seg, box, 0)).toBe(false); // the arrow does NOT cross the label
  });

  // The box is offset to the side, then slid ALONG the arrow to centre it. Near
  // an axis it centres the FACING edge (bottom/top, or left/right); as the arrow
  // turns diagonal it eases toward centring the nearest CORNER (~15°→30°). The
  // ease keeps near-axis arrows from jumping ~half a box-width sideways.
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const unit = (dir: { x: number; y: number }) => {
    const dl = Math.hypot(dir.x, dir.y);
    return { x: dir.x / dl, y: dir.y / dl };
  };
  const along = (p: { x: number; y: number }, anchor: { x: number; y: number }, du: { x: number; y: number }) =>
    (p.x - anchor.x) * du.x + (p.y - anchor.y) * du.y;
  const facingEdgeMid = (r: { x: number; y: number; side: string }, w: number, h: number) => {
    switch (r.side) {
      case 'above': return { x: r.x + w / 2, y: r.y + h }; // bottom edge faces the arrow
      case 'below': return { x: r.x + w / 2, y: r.y };     // top edge
      case 'right': return { x: r.x, y: r.y + h / 2 };     // left edge
      default:      return { x: r.x + w, y: r.y + h / 2 }; // 'left' → right edge
    }
  };
  const nearestCorner = (
    r: { x: number; y: number }, w: number, h: number,
    anchor: { x: number; y: number }, nrm: { x: number; y: number },
  ) => [
    { x: r.x, y: r.y }, { x: r.x + w, y: r.y }, { x: r.x, y: r.y + h }, { x: r.x + w, y: r.y + h },
  ].map((p) => ({ p, perp: Math.abs((p.x - anchor.x) * nrm.x + (p.y - anchor.y) * nrm.y) }))
    .sort((a, b) => a.perp - b.perp)[0]!.p;

  // Near an axis (≤15°): the FACING edge sits at the arrow midpoint.
  for (const [name, dir] of [
    ['10° above horizontal', { x: Math.cos(rad(10)), y: -Math.sin(rad(10)) }],
    ['10° below horizontal', { x: Math.cos(rad(10)), y: Math.sin(rad(10)) }],
    ['10° off vertical', { x: Math.sin(rad(10)), y: Math.cos(rad(10)) }],
  ] as const) {
    it(`centres the FACING edge for a near-axis arrow (${name})`, () => {
      const anchor = { x: 500, y: 400 };
      const du = unit(dir);
      const r = layoutLabelBox({ anchor, dirX: dir.x, dirY: dir.y, reserved: [], ...base })!;
      expect(along(facingEdgeMid(r, base.boxW, base.boxH), anchor, du)).toBeCloseTo(0, 3);
    });
  }

  // Diagonal (≥30° from both axes): the nearest CORNER sits at the arrow midpoint.
  for (const [name, dir] of [
    ['40° (horizontal-class)', { x: Math.cos(rad(40)), y: -Math.sin(rad(40)) }],
    ['45°', { x: Math.SQRT1_2, y: Math.SQRT1_2 }],
    ['50° (vertical-class)', { x: Math.cos(rad(50)), y: Math.sin(rad(50)) }],
  ] as const) {
    it(`centres the nearest CORNER for a diagonal arrow (${name})`, () => {
      const anchor = { x: 500, y: 400 };
      const du = unit(dir);
      const nrm = { x: -du.y, y: du.x };
      const r = layoutLabelBox({ anchor, dirX: dir.x, dirY: dir.y, reserved: [], ...base })!;
      expect(along(nearestCorner(r, base.boxW, base.boxH, anchor, nrm), anchor, du)).toBeCloseTo(0, 3);
    });
  }

  it('keeps a NEARLY-horizontal label centred (a slight slope must not jump it ~½ box-width)', () => {
    // Regression: a corner-based slide flung this ~boxW/2 sideways the instant
    // the slope crossed zero. The eased slide keeps it ~over the anchor.
    const anchor = { x: 500, y: 400 };
    const r = layoutLabelBox({ anchor, dirX: 1, dirY: 0.05, reserved: [], ...base })!;
    expect(Math.abs((r.x + base.boxW / 2) - anchor.x)).toBeLessThan(2);
  });

  it('eases smoothly through the blend zone (no cliff between 10° and 35°)', () => {
    const anchor = { x: 500, y: 400 };
    const centreX = (deg: number) => {
      const r = layoutLabelBox({ anchor, dirX: Math.cos(rad(deg)), dirY: -Math.sin(rad(deg)), reserved: [], ...base })!;
      return r.x + base.boxW / 2;
    };
    let prev = centreX(10);
    for (let d = 11; d <= 35; d++) {
      const cur = centreX(d);
      // A hard 20° threshold would jump ~boxW/2 (45px) in one step; smoothstep can't.
      expect(Math.abs(cur - prev)).toBeLessThan(12);
      prev = cur;
    }
  });
});

describe('segIntersectsRect', () => {
  const rect = { x: 100, y: 100, w: 50, h: 20 }; // [100,150] × [100,120]

  it('true when a segment passes through the rect', () => {
    expect(segIntersectsRect({ x1: 90, y1: 110, x2: 160, y2: 110 }, rect, 0)).toBe(true);
  });
  it('true when an endpoint is inside the rect', () => {
    expect(segIntersectsRect({ x1: 120, y1: 110, x2: 500, y2: 500 }, rect, 0)).toBe(true);
  });
  it('false when a segment is clearly outside', () => {
    expect(segIntersectsRect({ x1: 0, y1: 0, x2: 10, y2: 10 }, rect, 0)).toBe(false);
  });
  it('counts a near miss as a hit once clearance is applied', () => {
    const seg = { x1: 90, y1: 95, x2: 160, y2: 95 }; // 5px above the top edge
    expect(segIntersectsRect(seg, rect, 0)).toBe(false);
    expect(segIntersectsRect(seg, rect, 8)).toBe(true);
  });
});

describe('buildLabelCells', () => {
  const vp = { x: 0, y: 0, zoom: 1 };

  it('lays glyph cells on the screen grid and skips spaces', () => {
    const cells = buildLabelCells({ lines: ['A B'], boxX: 90, boxY: 180, cellPx: 9, viewport: vp });
    // 'A B' → A and B, the space is a gap (no cell)
    expect(cells.length).toBe(2);
    expect(cells[0]!.glyphIndex).toBe(statusGlyphIndex('A'));
    expect(cells[1]!.glyphIndex).toBe(statusGlyphIndex('B'));
    expect(cells[0]!.row).toBe(20);
    expect(cells[1]!.col).toBe(cells[0]!.col + 2); // 'A', gap, 'B'
  });

  it('centres a short line under a wider one', () => {
    const cells = buildLabelCells({ lines: ['ABCD', 'EF'], boxX: 0, boxY: 0, cellPx: 9, viewport: vp });
    const row0 = cells.filter((c) => c.row === 0).sort((a, b) => a.col - b.col);
    const row1 = cells.filter((c) => c.row === 1).sort((a, b) => a.col - b.col);
    expect(row0.map((c) => c.col)).toEqual([0, 1, 2, 3]);
    // 'EF' centred under width-4 → offset floor((4-2)/2)=1
    expect(row1.map((c) => c.col)).toEqual([1, 2]);
  });

  it('reports the world position of each cell for colour sampling', () => {
    const cells = buildLabelCells({ lines: ['A'], boxX: 90, boxY: 180, cellPx: 9, viewport: { x: 0, y: 0, zoom: 2 } });
    // col 10 centre screen = 10.5*9 = 94.5 → world 47.25 at zoom 2
    expect(cells[0]!.worldX).toBeCloseTo(94.5 / 2);
  });
});

describe('cellAccent', () => {
  const radii = { unfocused: 200, focused: 300, focusBoost: 2.33 };

  it('falls back to the parent accent when no aura covers the cell', () => {
    expect(cellAccent(9999, 9999, 'blue', [], radii)).toBe('blue');
  });

  it('takes another node aura accent when the cell sits inside it', () => {
    const owners: AuraOwner[] = [{ nodeId: 'n', rect: { x: 0, y: 0, w: 100, h: 100 }, accent: 'mauve', focused: false }];
    expect(cellAccent(50, 50, 'blue', owners, radii)).toBe('mauve');
  });

  it('picks the strongest overlapping aura (closest border wins)', () => {
    const owners: AuraOwner[] = [
      { nodeId: 'far', rect: { x: 0, y: 0, w: 10, h: 10 }, accent: 'red', focused: false },
      { nodeId: 'near', rect: { x: 90, y: 90, w: 20, h: 20 }, accent: 'green', focused: false },
    ];
    // point (100,100) is INSIDE 'near' (d=0, steady=1) but only weakly in 'far'.
    expect(cellAccent(100, 100, 'blue', owners, radii)).toBe('green');
  });
});

describe('labelWrapCandidates', () => {
  it('offers fewest-lines (widest) first, then narrower fallbacks', () => {
    const c = labelWrapCandidates('AAAA BBBB', 33, 3);
    expect(c.map((l) => l.length)).toEqual([1, 2]); // a 1-line form, then a 2-line form
    expect(c[0]).toEqual(['AAAA BBBB']);
    expect(c[1]).toEqual(['AAAA', 'BBBB']);
  });
  it('returns [] when the text cannot fit within the line limit', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    expect(labelWrapCandidates(long, 33, 3)).toEqual([]);
  });
  it('gives a single candidate for an unsplittable single word', () => {
    expect(labelWrapCandidates('PHOTOSYNTHESIS', 33, 3)).toEqual([['PHOTOSYNTHESIS']]);
  });
});

describe('clipVisibleSpan', () => {
  it('turns a centre-to-centre line into the border-to-border segment', () => {
    const fromRect = { x: 0, y: 0, w: 100, h: 50 };   // centre (50, 25)
    const toRect = { x: 300, y: 0, w: 100, h: 50 };   // centre (350, 25)
    const span = clipVisibleSpan([{ x: 50, y: 25 }, { x: 350, y: 25 }], fromRect, toRect)!;
    expect(span[0]).toEqual({ x: 100, y: 25 });            // exits fromRect's right border
    expect(span[span.length - 1]).toEqual({ x: 300, y: 25 }); // enters toRect's left border
  });
  it('trims a chain whose tail points dip inside the target card', () => {
    const fromRect = { x: -200, y: 0, w: 100, h: 50 };
    const toRect = { x: 300, y: 0, w: 100, h: 50 };
    const span = clipVisibleSpan(
      [{ x: 100, y: 25 }, { x: 310, y: 25 }, { x: 340, y: 25 }],
      fromRect, toRect,
    )!;
    expect(span[0]).toEqual({ x: 100, y: 25 });
    expect(span[span.length - 1]!.x).toBeCloseTo(300);
    expect(span[span.length - 1]!.y).toBeCloseTo(25);
  });
  it('leaves a polyline already outside both cards untouched', () => {
    const pts = [{ x: 100, y: 25 }, { x: 200, y: 60 }, { x: 300, y: 25 }];
    const span = clipVisibleSpan(pts, { x: 0, y: 0, w: 90, h: 50 }, { x: 310, y: 0, w: 90, h: 50 })!;
    expect(span).toEqual(pts);
  });
  it('returns null when the cards overlap and swallow the whole arrow', () => {
    const fromRect = { x: 0, y: 0, w: 200, h: 100 };
    const toRect = { x: 50, y: 0, w: 200, h: 100 };
    expect(clipVisibleSpan([{ x: 100, y: 50 }, { x: 150, y: 50 }], fromRect, toRect)).toBeNull();
  });
});

describe('longestOnScreenRun', () => {
  const view = { x: 0, y: 0, w: 1000, h: 800 };
  it('returns a fully visible polyline unchanged', () => {
    const pts = [{ x: 10, y: 10 }, { x: 500, y: 300 }];
    expect(longestOnScreenRun(pts, view)).toEqual(pts);
  });
  it('cuts a run at the screen border when the polyline exits', () => {
    const run = longestOnScreenRun([{ x: 500, y: 400 }, { x: 1200, y: 400 }], view)!;
    expect(run[0]).toEqual({ x: 500, y: 400 });
    expect(run[run.length - 1]!.x).toBeCloseTo(1000);
  });
  it('picks the longest run when the polyline exits and re-enters', () => {
    const run = longestOnScreenRun(
      [{ x: 900, y: 100 }, { x: 1100, y: 100 }, { x: 1100, y: 700 }, { x: 100, y: 700 }],
      view,
    )!;
    expect(run[0]!.x).toBeCloseTo(1000);
    expect(run[0]!.y).toBeCloseTo(700);
    expect(run[run.length - 1]).toEqual({ x: 100, y: 700 });
  });
  it('returns null when nothing is on screen', () => {
    expect(longestOnScreenRun([{ x: 1200, y: 100 }, { x: 1500, y: 100 }], view)).toBeNull();
  });
});

describe('computeArrowLabels', () => {
  // Card rects far off the test polylines: clipping leaves the points as-is.
  const FAR_FROM = { x: -9999, y: -9999, w: 1, h: 1 };
  const FAR_TO = { x: 9999, y: 9999, w: 1, h: 1 };
  const arrow = (id: string, points: { x: number; y: number }[]) =>
    ({ id, fromNodeId: 'p', toNodeId: 'c', points, fromRect: FAR_FROM, toRect: FAR_TO });

  const baseInput = (over: Partial<ArrowLabelInput>): ArrowLabelInput => ({
    arrows: [arrow('a1', [{ x: 0, y: 400 }, { x: 200, y: 400 }])],
    headerOf: (id) => (id === 'c' ? 'Child' : 'Parent'),
    fullyVisible: () => false,
    partiallyVisible: () => true,
    parentAccentOf: () => 'blue',
    viewport: { x: 0, y: 0, zoom: 1 },
    screenW: 1000,
    screenH: 800,
    cellPx: 9,
    reserved: [],
    owners: [],
    ...over,
  });

  it('produces a placement showing the child header for a basic arrow', () => {
    const out = computeArrowLabels(baseInput({}));
    expect(out.length).toBe(1);
    expect(out[0]!.arrowId).toBe('a1');
    expect(out[0]!.text).toBe('CHILD');
    expect(out[0]!.targetNodeId).toBe('c');
    expect(out[0]!.hitRect.w).toBe(5 * 9);
    expect(out[0]!.hitRect.h).toBe(9);
    expect(out[0]!.hitRect.x % 9).toBe(0);
    expect(out[0]!.hitRect.y % 9).toBe(0);
    expect(out[0]!.cells.length).toBe(5); // C H I L D
    expect(out[0]!.accents.length).toBe(out[0]!.cells.length);
    expect(out[0]!.accents[0]).toBe('blue');
  });

  it('requires at least 200 world/canvas pixels of card-clipped rope, independent of zoom', () => {
    for (const zoom of [0.5, 1, 2]) {
      expect(computeArrowLabels(baseInput({
        arrows: [arrow('short', [{ x: 300, y: 400 }, { x: 499, y: 400 }])],
        viewport: { x: 0, y: 0, zoom },
      }))).toHaveLength(0);
      expect(computeArrowLabels(baseInput({
        arrows: [arrow('exact', [{ x: 300, y: 400 }, { x: 500, y: 400 }])],
        viewport: { x: 0, y: 0, zoom },
      }))).toHaveLength(1);
    }
  });

  it('skips an arrow whose chosen header is empty', () => {
    expect(computeArrowLabels(baseInput({ headerOf: () => '' })).length).toBe(0);
  });

  it('skips a header that would wrap past the max line count', () => {
    const longHeader = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const out = computeArrowLabels(baseInput({ headerOf: () => longHeader }));
    expect(out.length).toBe(0);
  });

  it('respects the max-lines constant (sanity)', () => {
    expect(LABEL_MAX_LINES).toBe(5);
  });

  it('shows a header that wraps to 4 lines (within the 5-line limit)', () => {
    // 24 four-letter words wrap to 4 lines at the 33-col max width — too many
    // for the old 3-line limit (would be skipped), but within the new 5-line one.
    const header = Array.from({ length: 24 }, () => 'ABCD').join(' ');
    const out = computeArrowLabels(baseInput({
      // Arrow centred so the wide (~4-line) box has room on every side.
      arrows: [arrow('a1', [{ x: 300, y: 400 }, { x: 700, y: 400 }])],
      headerOf: () => header,
    }));
    expect(out.length).toBe(1);
    const rows = new Set(out[0]!.cells.map((c) => c.row));
    expect(rows.size).toBeGreaterThanOrEqual(4);
  });

  it('gives the longer arrow first pick and pushes the shorter label to the other side', () => {
    const out = computeArrowLabels(baseInput({
      arrows: [
        arrow('long', [{ x: 0, y: 400 }, { x: 600, y: 400 }]),
        arrow('short', [{ x: 200, y: 400 }, { x: 400, y: 400 }]),
      ],
      headerOf: () => 'AAAA',
    }));
    expect(out.length).toBe(2);
    const long = out.find((o) => o.arrowId === 'long')!;
    const short = out.find((o) => o.arrowId === 'short')!;
    const longMaxRow = Math.max(...long.cells.map((c) => c.row));
    const shortMinRow = Math.min(...short.cells.map((c) => c.row));
    // both midpoints are at x=300,y=400: long takes ABOVE, short flips BELOW.
    expect(shortMinRow).toBeGreaterThan(longMaxRow);
  });

  it('keeps a label off any arrow line that would otherwise cut through it', () => {
    // 'main' is horizontal at y=400 (label would default ABOVE, ~row 42). 'bar'
    // runs along y=382 — straight through where main's above-box sits — so main
    // must drop BELOW (~row 46) to keep its letters clear of the line.
    const out = computeArrowLabels(baseInput({
      arrows: [
        arrow('main', [{ x: 0, y: 400 }, { x: 400, y: 400 }]),
        arrow('bar', [{ x: 150, y: 382 }, { x: 250, y: 382 }]),
      ],
      headerOf: () => 'AAAA',
    }));
    const main = out.find((o) => o.arrowId === 'main')!;
    expect(main).toBeTruthy();
    expect(Math.min(...main.cells.map((c) => c.row))).toBeGreaterThan(44);
  });

  it('wraps a one-line label to more lines instead of vanishing when space is tight', () => {
    // Near the right edge the wide 1-line box would clip off-screen on both
    // sides; the narrower 2-line wrap fits, so the label re-shapes (it must NOT
    // just disappear). The arrow stays fully on screen — an off-screen tail
    // would now pull the anchor inward (label follows the on-screen run).
    const out = computeArrowLabels(baseInput({
      arrows: [arrow('a1', [{ x: 500, y: 100 }, { x: 500, y: 300 }])],
      headerOf: () => 'AAAA BBBB',
      // Block only the far ends of the wide one-line boxes on both sides.
      // The narrower two-line box clears these reservations.
      reserved: [
        { x: 560, y: 185, w: 35, h: 30 },
        { x: 405, y: 185, w: 35, h: 30 },
      ],
    }));
    expect(out.length).toBe(1);
    const rows = new Set(out[0]!.cells.map((c) => c.row));
    expect(rows.size).toBe(2); // wrapped onto 2 lines to fit
  });

  it('anchors at the middle of the GAP between the cards, not the centre-to-centre middle', () => {
    // Wide parent card + tiny child card. Centre-to-centre line runs (200,400)
    // → (820,400), mathematical middle x=510; the VISIBLE gap spans the parent's
    // right border (x=400) to the child's left border (x=800), middle x=600.
    const fromRect = { x: 0, y: 200, w: 400, h: 400 };
    const toRect = { x: 800, y: 380, w: 40, h: 40 };
    const out = computeArrowLabels(baseInput({
      arrows: [{
        id: 'a1', fromNodeId: 'p', toNodeId: 'c',
        points: [{ x: 200, y: 400 }, { x: 820, y: 400 }],
        fromRect, toRect,
      }],
      headerOf: () => 'AAAA',
    }));
    expect(out.length).toBe(1);
    const cols = out[0]!.cells.map((c) => c.col);
    const meanPx = (cols.reduce((s, c) => s + c, 0) / cols.length) * 9 + 4.5;
    expect(Math.abs(meanPx - 600)).toBeLessThan(27);  // centred on the gap (±3 cells)
    expect(meanPx - 510).toBeGreaterThan(45);          // clearly NOT the old midpoint
  });

  it('keeps the label with the on-screen part of an arrow from a far off-screen parent', () => {
    // Parent card far left of the viewport; the full-line midpoint (x=-700) is
    // off screen (the old code dropped the label). The on-screen run spans
    // x=0..300, so the label now lands near x=150 and names the unseen parent.
    const fromRect = { x: -2000, y: 300, w: 400, h: 200 }; // centre (-1800, 400)
    const toRect = { x: 300, y: 350, w: 200, h: 100 };     // centre (400, 400)
    const out = computeArrowLabels(baseInput({
      arrows: [{
        id: 'a1', fromNodeId: 'p', toNodeId: 'c',
        points: [{ x: -1800, y: 400 }, { x: 400, y: 400 }],
        fromRect, toRect,
      }],
      fullyVisible: (id) => id === 'c',
      partiallyVisible: (id) => id === 'c',
    }));
    expect(out.length).toBe(1);
    expect(out[0]!.text).toBe('PARENT');
    expect(out[0]!.targetNodeId).toBe('p');
    const cols = out[0]!.cells.map((c) => c.col);
    const meanPx = (cols.reduce((s, c) => s + c, 0) / cols.length) * 9 + 4.5;
    expect(Math.abs(meanPx - 150)).toBeLessThan(30); // centred on the visible run
  });
});
