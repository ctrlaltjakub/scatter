/**
 * Per-cell diff cache for the Scatter screen-fixed paint path.
 *
 * The screen-locked paint only redraws cells whose stage (or focus) has
 * changed since the previous paint — measured by a per-cell fingerprint
 * stored in a Map<cellKey, cellState>. Extracted from AsciiAuraLayer's
 * paint() so the invariants can be unit-tested directly.
 *
 * Encoding choices:
 *   - cellKey packs signed (col, row) into a single integer so a Map
 *     keyed by it stays primitive-fast. Range: col/row ∈ [-32768, 32767].
 *   - cellState packs stage (0..15) + focused bit so equality is a
 *     single integer compare. Storing STAGE (not glyph) is what makes
 *     the glyph cooldown work — the displayed glyph is derived from
 *     (stage, seed) each paint via pickGlyph.
 */

const KEY_BIAS = 32768;
const KEY_STRIDE = 65536;

export function encodeCellKey(col: number, row: number): number {
  return ((col + KEY_BIAS) * KEY_STRIDE) + (row + KEY_BIAS);
}

export function decodeCellKey(key: number): { col: number; row: number } {
  return {
    col: Math.floor(key / KEY_STRIDE) - KEY_BIAS,
    row: (key % KEY_STRIDE) - KEY_BIAS,
  };
}

/** Pack a cell's displayed stage + focus into a single integer.
 *  Stage occupies bits 1..N; focused is bit 0. */
export function encodeCellState(stage: number, focused: boolean): number {
  return (stage << 1) | (focused ? 1 : 0);
}

export function decodeStage(state: number): number {
  return state >> 1;
}

/** Smooth-cooldown step: when a cell's target stage is LOWER than what
 *  was drawn last paint, step down by one stage. Heating (target up) is
 *  instant; cooling floors at 0.
 *
 *  Combined with the diff-cache loop, this produces a multi-frame fade
 *  trail behind decaying waves and freshly unfocused nodes — the glyph
 *  walks through intermediate stages on the way down. */
export function coolStage(last: number, target: number): number {
  return target >= last ? target : Math.max(0, last - 1);
}

/**
 * Should the paint loop redraw this cell?
 *   - on full refresh, yes (the canvas was cleared)
 *   - if the cell wasn't drawn last paint, yes (it's a new aura cell)
 *   - if the last state matches the new state, no (already correct on
 *     the canvas)
 */
export function shouldRedrawCell(
  needsFullRefresh: boolean,
  lastCellState: ReadonlyMap<number, number>,
  cellKey: number,
  newState: number,
): boolean {
  if (needsFullRefresh) return true;
  const last = lastCellState.get(cellKey);
  return last !== newState;
}

/**
 * Find cells that were drawn last paint but NOT in this paint — they
 * need to be cooled one step (or erased back to baseline if they were
 * already at the lowest non-baseline stage).
 *
 * Skips any stale cell whose decoded coordinates fall outside the
 * current visible grid (cellsX × cellsY). Such cells correspond to
 * positions that were on-screen last paint but are off-screen now
 * because the canvas resized — touching them would write outside the
 * backing buffer.
 */
export function collectStaleCells(
  lastCellState: ReadonlyMap<number, number>,
  newCellState: ReadonlyMap<number, number>,
  cellsX: number,
  cellsY: number,
): Array<{ col: number; row: number }> {
  const stale: Array<{ col: number; row: number }> = [];
  for (const oldKey of lastCellState.keys()) {
    if (newCellState.has(oldKey)) continue;
    const { col, row } = decodeCellKey(oldKey);
    if (col < 0 || col >= cellsX || row < 0 || row >= cellsY) continue;
    stale.push({ col, row });
  }
  return stale;
}
