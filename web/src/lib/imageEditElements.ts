/**
 * Image-editor document model + undo history — pure data, no DOM/Konva.
 *
 * The editor works on an EditorDoc (annotation elements + color adjustments +
 * crop state) wrapped in an EditorHistory. Continuous gestures (a pen stroke,
 * a transformer drag, a slider scrub) stream `transient` ops that mutate the
 * present doc without growing the past; `commitGesture` on release turns the
 * whole gesture into exactly ONE undo entry. This history is editor-internal —
 * it never touches the app's zundo temporal store.
 *
 * All coordinates are IMAGE pixels (the stage renders at image scale, so what
 * you see is exactly what bakes).
 */

export type AnnotTool = 'pen' | 'highlighter' | 'text' | 'arrow';

interface AnnotBase {
  id: string;
  color: string;      // concrete hex (already resolved from accent names)
  x: number;
  y: number;
  rotation: number;   // degrees
  scaleX: number;
  scaleY: number;
}

/** Freehand pen / highlighter stroke: points are [x0,y0,x1,y1,…] relative to (x,y). */
export interface StrokeEl extends AnnotBase {
  tool: 'pen' | 'highlighter';
  points: number[];
  strokeWidth: number;
}

export interface TextEl extends AnnotBase {
  tool: 'text';
  text: string;
  fontFamily: string; // concrete family string usable by canvas (resolved at creation)
  fontSize: number;   // image px
  width?: number;     // wrap width; undefined = auto
  minHeight?: number; // dragged box height; grows with text rather than clipping it
}

/** Straight arrow: points are [x0,y0,x1,y1] relative to (x,y). */
export interface ArrowEl extends AnnotBase {
  tool: 'arrow';
  points: number[];
  strokeWidth: number;
}

export type AnnotEl = StrokeEl | TextEl | ArrowEl;

/** Everything an element update may patch (position, transform, tool fields). */
export type AnnotElPatch = Partial<Omit<StrokeEl, 'id' | 'tool'>> &
  Partial<Omit<TextEl, 'id' | 'tool'>> &
  Partial<Omit<ArrowEl, 'id' | 'tool'>>;

/** Color adjustments; 0 on every axis = untouched image. */
export interface Adjustments {
  saturation: number; // −100..100
  warmth: number;     // −100..100 (custom R+/B− filter)
  contrast: number;   // −100..100
  hue: number;        // −180..180 degrees
}

export const NEUTRAL_ADJUSTMENTS: Adjustments = Object.freeze({
  saturation: 0,
  warmth: 0,
  contrast: 0,
  hue: 0,
});

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropState {
  /** Crop window in (turned) image coordinates; null = full frame. */
  rect: CropRect | null;
  /** 90° rotations applied before everything else (0..3, clockwise). */
  quarterTurns: 0 | 1 | 2 | 3;
  /** Fine straighten angle in degrees (−45..45); auto-zoom keeps coverage. */
  fineAngle: number;
}

export interface EditorDoc {
  elements: AnnotEl[];
  adjustments: Adjustments;
  crop: CropState;
}

export function emptyDoc(): EditorDoc {
  return {
    elements: [],
    adjustments: { ...NEUTRAL_ADJUSTMENTS },
    crop: { rect: null, quarterTurns: 0, fineAngle: 0 },
  };
}

// ── Ops ─────────────────────────────────────────────────────────────────────

export type EditorOp =
  | { kind: 'addElement'; el: AnnotEl }
  | { kind: 'updateElement'; id: string; patch: AnnotElPatch }
  | { kind: 'removeElements'; ids: string[] }
  | { kind: 'setAdjustments'; patch: Partial<Adjustments> }
  | { kind: 'setCrop'; patch: Partial<CropState> };

function applyToDoc(doc: EditorDoc, op: EditorOp): EditorDoc {
  switch (op.kind) {
    case 'addElement':
      return { ...doc, elements: [...doc.elements, op.el] };
    case 'updateElement':
      return {
        ...doc,
        elements: doc.elements.map((el) =>
          el.id === op.id ? ({ ...el, ...op.patch } as AnnotEl) : el),
      };
    case 'removeElements': {
      const gone = new Set(op.ids);
      return { ...doc, elements: doc.elements.filter((el) => !gone.has(el.id)) };
    }
    case 'setAdjustments':
      return { ...doc, adjustments: { ...doc.adjustments, ...op.patch } };
    case 'setCrop':
      return { ...doc, crop: { ...doc.crop, ...op.patch } };
  }
}

// ── History ─────────────────────────────────────────────────────────────────

export const HISTORY_LIMIT = 100;

export interface EditorHistory {
  past: EditorDoc[];
  present: EditorDoc;
  future: EditorDoc[];
  /** Doc as it was before the in-flight gesture (null = no gesture running). */
  pendingBase: EditorDoc | null;
}

export function initHistory(doc: EditorDoc): EditorHistory {
  return { past: [], present: doc, future: [], pendingBase: null };
}

function pushPast(past: EditorDoc[], doc: EditorDoc): EditorDoc[] {
  const next = [...past, doc];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/**
 * Apply an op. `transient: true` marks it as part of a continuous gesture:
 * the present updates but no undo entry is created until `commitGesture`.
 * A non-transient op while a gesture is somehow still open commits it first.
 */
export function applyOp(
  h: EditorHistory,
  op: EditorOp,
  opts?: { transient?: boolean },
): EditorHistory {
  if (opts?.transient) {
    return {
      past: h.past,
      present: applyToDoc(h.present, op),
      future: [],
      pendingBase: h.pendingBase ?? h.present,
    };
  }
  const base = commitGesture(h);
  return {
    past: pushPast(base.past, base.present),
    present: applyToDoc(base.present, op),
    future: [],
    pendingBase: null,
  };
}

/** Close the running gesture: one undo entry (none if nothing changed). */
export function commitGesture(h: EditorHistory): EditorHistory {
  if (h.pendingBase === null) return h;
  if (deepEqual(h.pendingBase, h.present)) {
    return { ...h, pendingBase: null };
  }
  return { past: pushPast(h.past, h.pendingBase), present: h.present, future: h.future, pendingBase: null };
}

export function canUndo(h: EditorHistory): boolean {
  return h.past.length > 0 || h.pendingBase !== null;
}

export function canRedo(h: EditorHistory): boolean {
  return h.future.length > 0;
}

export function undo(h: EditorHistory): EditorHistory {
  const c = commitGesture(h);
  if (c.past.length === 0) return c;
  return {
    past: c.past.slice(0, -1),
    present: c.past[c.past.length - 1]!,
    future: [c.present, ...c.future],
    pendingBase: null,
  };
}

export function redo(h: EditorHistory): EditorHistory {
  const c = commitGesture(h);
  if (c.future.length === 0) return c;
  return {
    past: pushPast(c.past, c.present),
    present: c.future[0]!,
    future: c.future.slice(1),
    pendingBase: null,
  };
}

/** True when the present differs from the given baseline (usually emptyDoc()). */
export function isDirty(h: EditorHistory, baseline: EditorDoc): boolean {
  return !deepEqual(h.present, baseline);
}

// ── Structural equality (plain JSON-ish values only) ────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
