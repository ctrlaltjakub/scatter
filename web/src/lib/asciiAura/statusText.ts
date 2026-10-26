/**
 * Live AI-status text for the ASCII aura field (Part F).
 *
 * During generation the field spells out a short status near the node
 * being worked on ("GENERATING TEXT", "MARKING CHIPS", …). The letters
 * are TRUE aura cells: a glyph-index override per cell, drawn by the
 * renderer in a distinct, undimmed colour. This module is the pure
 * brain — it owns the alphabet, the per-cell placement above (or, when
 * there's no room, below) the node, and the type-on / delete animation.
 * Both renderers consume it; it knows nothing about WebGL or canvas.
 *
 * Atlas contract: status glyphs live in the atlas AFTER the density ramp
 * (RAMP_FLAT), so the ramp's glyph indices — and the TS↔GLSL parity that
 * depends on them — are untouched. `statusGlyphIndex` returns the
 * ABSOLUTE atlas index for a character.
 */
import { RAMP_FLAT } from './ramp';

/** Renderable status / label characters, in atlas order (placed AFTER
 *  RAMP_FLAT). Uppercase only — Press Start 2P reads best in caps, so callers
 *  uppercase their text first. Space is absent on purpose: a space produces NO
 *  override cell, so the aura field shows through the gaps between words. The
 *  trailing punctuation ( , ' ( ) / & ? ! ~ ) lets the ASCII labels render
 *  real titles; it is appended at the END so every existing glyph index — and
 *  the TS↔GLSL atlas parity that rides on it — stays unchanged. */
export const STATUS_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:-.,'()/&?!~+_\\|";

/** ms between successive characters appearing (type-on, left to right). */
export const STATUS_REVEAL_MS_PER_CHAR = 18;
/** ms between successive characters vanishing (delete, right to left). */
export const STATUS_DELETE_MS_PER_CHAR = 16;
/** Blank grid rows left between the node's top edge and the status text. */
export const STATUS_GAP_ROWS = 0;
/** ms per step of the trailing "working" dots ( . → .. → ... → . ). */
export const STATUS_DOT_PERIOD_MS = 400;
/** Dot columns reserved when centring the last line, so the text stays put
 *  as the working dots cycle 1→3. */
export const STATUS_DOT_RESERVE = 3;
/** Smallest line width (in cells) we'll wrap to, even for a narrow node —
 *  keeps short statuses on one line under a small card. */
const MIN_LINE_CELLS = 10;

export interface ScreenRect {
  /** All in CSS pixels (screen space). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StatusCell {
  col: number;
  row: number;
  /** Absolute atlas glyph index (≥ RAMP_FLAT.length). */
  glyphIndex: number;
}

export interface StatusProcessInput {
  text: string;
  startedAt: number;
  clearedAt: number | null;
}

/** Absolute atlas glyph index for a status character, or null when the
 *  character isn't renderable (space / unknown / lowercase). */
export function statusGlyphIndex(ch: string): number | null {
  const i = STATUS_CHARS.indexOf(ch);
  return i < 0 ? null : RAMP_FLAT.length + i;
}

/** Number of renderable (non-space, known) characters in `text`,
 *  case-insensitively. Drives the animation ordinals. */
export function renderableCount(text: string): number {
  const up = text.toUpperCase();
  let n = 0;
  for (const ch of up) {
    if (STATUS_CHARS.indexOf(ch) >= 0) n++;
  }
  return n;
}

/**
 * Is character ordinal `k` (0-based, counted left→right over the renderable
 * chars) currently shown, given the type-on (left→right) / backspace-delete
 * (right→left) animation? Extracted from layoutStatus so the status field and
 * the arrow header-labels animate through the exact same gate.
 */
export function isCharShown(
  k: number,
  total: number,
  startedAt: number,
  clearedAt: number | null,
  now: number,
): boolean {
  // Type-on: this char hasn't appeared yet.
  if (now - startedAt < k * STATUS_REVEAL_MS_PER_CHAR) return false;
  // Delete right-to-left: the highest ordinal vanishes first.
  if (clearedAt != null && now - clearedAt >= (total - 1 - k) * STATUS_DELETE_MS_PER_CHAR) return false;
  return true;
}

/** Greedy word-wrap into lines no wider than `maxCells`. Words longer
 *  than `maxCells` are hard-split. Returns [] for empty text. */
export function wrapStatus(text: string, maxCells: number): string[] {
  const limit = Math.max(1, maxCells);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    let word = w;
    // Hard-split a word that can never fit on one line.
    while (word.length > limit) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, limit));
      word = word.slice(limit);
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= limit) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Lay a status string into grid cells near its node, applying the
 * reveal/delete animation for the given timestamps.
 *
 * Placement: the LAST wrapped line sits one row above the node's top
 * edge; earlier lines stack upward (so reading top→bottom is natural).
 * When there isn't room above (node near the top of the screen) the
 * whole block is placed just below the node instead.
 *
 * Animation: characters appear left-to-right (by `startedAt`) and, once
 * `clearedAt` is set, vanish right-to-left. Cells outside [0,cols)×
 * [0,rows) are culled.
 */
export function layoutStatus(opts: {
  text: string;
  node: ScreenRect;
  cellPx: number;
  cols: number;
  rows: number;
  startedAt: number;
  clearedAt: number | null;
  now: number;
}): StatusCell[] {
  const { node, cellPx, cols, rows, startedAt, clearedAt, now } = opts;
  const text = opts.text.toUpperCase();
  const total = renderableCount(text);
  if (total === 0) return [];

  const topRow = Math.floor(node.y / cellPx);
  const bottomRow = Math.floor((node.y + node.h) / cellPx);
  // Centred horizontally over the node. The last line reserves room for the
  // full 3 working dots so the text doesn't shift as they cycle 1→3.
  const centerCol = (node.x + node.w / 2) / cellPx;
  const startColFor = (lineLen: number, isLast: boolean) =>
    Math.round(centerCol - (lineLen + (isLast ? STATUS_DOT_RESERVE : 0)) / 2);
  const widthCells = Math.max(MIN_LINE_CELLS, Math.round(node.w / cellPx));
  const lines = wrapStatus(text, widthCells);
  const numLines = lines.length;
  if (numLines === 0) return [];

  // Prefer above with a STATUS_GAP_ROWS gap: the LAST line sits that many
  // rows above the node top, earlier lines stack upward. If that clips off
  // the top, drop the block below the node instead.
  const placeBelow = topRow - numLines - STATUS_GAP_ROWS < 0;
  const rowForLine = (li: number) =>
    placeBelow
      ? bottomRow + 1 + STATUS_GAP_ROWS + li
      : topRow - numLines - STATUS_GAP_ROWS + li;

  const out: StatusCell[] = [];
  let ord = 0;
  for (let li = 0; li < numLines; li++) {
    const line = lines[li]!;
    const row = rowForLine(li);
    const startCol = startColFor(line.length, li === numLines - 1);
    for (let ci = 0; ci < line.length; ci++) {
      const gi = statusGlyphIndex(line[ci]!);
      if (gi == null) continue; // a space inside a line: keep the column gap
      const k = ord++;
      if (!isCharShown(k, total, startedAt, clearedAt, now)) continue;
      const col = startCol + ci;
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      out.push({ col, row, glyphIndex: gi });
    }
  }

  // Trailing "working" dots — appended after the last line once the base is
  // fully typed on and not yet clearing. They cycle . → .. → ... by wall
  // clock, independent of the reveal/delete ordinals (so they never shift the
  // base timing and are excluded from statusFullyDeleted).
  const fullyRevealed = now - startedAt >= total * STATUS_REVEAL_MS_PER_CHAR;
  if (fullyRevealed && clearedAt == null) {
    const dotGlyph = statusGlyphIndex('.')!;
    const lastLine = lines[numLines - 1]!;
    const row = rowForLine(numLines - 1);
    const startCol = startColFor(lastLine.length, true) + lastLine.length;
    const dotCount = (Math.floor(now / STATUS_DOT_PERIOD_MS) % 3) + 1;
    for (let d = 0; d < dotCount; d++) {
      const col = startCol + d;
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      out.push({ col, row, glyphIndex: dotGlyph });
    }
  }
  return out;
}

/** Lay several independently animated node processes under one shared STATUS:
 * heading. Each process keeps its own type-on/backspace timeline, so finishing
 * image discovery does not restart or disturb a simultaneous generation line. */
export function layoutStatusProcesses(opts: {
  processes: readonly StatusProcessInput[];
  node: ScreenRect;
  cellPx: number;
  cols: number;
  rows: number;
  now: number;
}): StatusCell[] {
  const { node, cellPx, cols, rows, now } = opts;
  const processes = opts.processes
    .map((process) => ({ ...process, text: process.text.replace(/^STATUS:\s*/i, '').toUpperCase() }))
    .filter((process) => renderableCount(process.text) > 0);
  if (processes.length === 0) return [];
  const widthCells = Math.max(MIN_LINE_CELLS, Math.round(node.w / cellPx));
  const blocks = processes.map((process) => ({ process, lines: wrapStatus(process.text, widthCells) }));
  const heading = 'STATUS:';
  const lineCount = 1 + blocks.reduce((sum, block) => sum + block.lines.length, 0);
  const topRow = Math.floor(node.y / cellPx);
  const bottomRow = Math.floor((node.y + node.h) / cellPx);
  const placeBelow = topRow - lineCount - STATUS_GAP_ROWS < 0;
  const firstRow = placeBelow
    ? bottomRow + 1 + STATUS_GAP_ROWS
    : topRow - lineCount - STATUS_GAP_ROWS;
  const centerCol = (node.x + node.w / 2) / cellPx;
  const out: StatusCell[] = [];

  const writeLine = (
    line: string,
    row: number,
    ordinal: { value: number },
    process: StatusProcessInput,
    total: number,
    reserveDots: boolean,
  ) => {
    const startCol = Math.round(centerCol - (line.length + (reserveDots ? STATUS_DOT_RESERVE : 0)) / 2);
    for (let i = 0; i < line.length; i++) {
      const glyphIndex = statusGlyphIndex(line[i]!);
      if (glyphIndex == null) continue;
      const k = ordinal.value++;
      if (!isCharShown(k, total, process.startedAt, process.clearedAt, now)) continue;
      const col = startCol + i;
      if (col >= 0 && col < cols && row >= 0 && row < rows) out.push({ col, row, glyphIndex });
    }
  };

  const firstStart = Math.min(...processes.map((process) => process.startedAt));
  const headingProcess: StatusProcessInput = { text: heading, startedAt: firstStart, clearedAt: null };
  writeLine(heading, firstRow, { value: 0 }, headingProcess, renderableCount(heading), false);

  let row = firstRow + 1;
  for (const block of blocks) {
    const total = renderableCount(block.process.text);
    const ordinal = { value: 0 };
    for (let lineIndex = 0; lineIndex < block.lines.length; lineIndex++) {
      const line = block.lines[lineIndex]!;
      const isLast = lineIndex === block.lines.length - 1;
      writeLine(line, row, ordinal, block.process, total, isLast);
      if (
        isLast
        && block.process.clearedAt == null
        && now - block.process.startedAt >= total * STATUS_REVEAL_MS_PER_CHAR
      ) {
        const startCol = Math.round(centerCol - (line.length + STATUS_DOT_RESERVE) / 2) + line.length;
        const dots = (Math.floor(now / STATUS_DOT_PERIOD_MS) % 3) + 1;
        for (let d = 0; d < dots; d++) {
          const col = startCol + d;
          if (col >= 0 && col < cols && row >= 0 && row < rows) {
            out.push({ col, row, glyphIndex: statusGlyphIndex('.')! });
          }
        }
      }
      row += 1;
    }
  }
  return out;
}

/** True once a cleared status has finished its delete animation and can
 *  be pruned from the store. */
export function statusFullyDeleted(
  text: string,
  clearedAt: number | null,
  now: number,
): boolean {
  if (clearedAt == null) return false;
  const total = renderableCount(text);
  return now - clearedAt >= total * STATUS_DELETE_MS_PER_CHAR + 60;
}
