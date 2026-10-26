/**
 * R5 — GPU cooling: time-based stage decay + RGBA8 byte encoding.
 *
 * The original CPU cadence cooled a cell one ramp stage per paint
 * (coolStage in cellDiff.ts — kept as the reference spec), which at its
 * 50 ms urgent cadence means 20 stages per second. The GPU renders at
 * display refresh rate, so cooling becomes explicitly time-based: same
 * average speed, now frame-rate-independent (a 144 Hz display fades
 * exactly as fast as a 60 Hz one).
 *
 * The displayed stage persists between frames in a ping-pong RGBA8
 * cell-state texture: R holds the integer stage (0–8), G holds the
 * fractional part quantized to 1/255 (≈ 0.2 ms of decay — can never
 * stall). These functions are the spec the pass-A GLSL mirrors, and
 * what the unit tests pin against the legacy coolStage chain.
 */

/** 1 stage per 50 ms — the legacy urgent-cadence cooling speed. */
export const COOL_STAGES_PER_SEC = 20;

/**
 * Advance a cell's displayed stage toward `target` over `dtMs`.
 * Heating (target above displayed) is instant; cooling decays at
 * COOL_STAGES_PER_SEC and floors at the target.
 */
export function coolDisplayedStage(
  prevDisplayed: number,
  target: number,
  dtMs: number,
): number {
  if (target >= prevDisplayed) return target;
  const cooled = prevDisplayed - (dtMs / 1000) * COOL_STAGES_PER_SEC;
  return cooled < target ? target : cooled;
}

/** Encode a (possibly fractional) stage into the R and G bytes of an
 *  RGBA8 texel: R = integer part, G = fraction × 255 (rounded). */
export function encodeStageBytes(stage: number): [r: number, g: number] {
  const i = Math.floor(stage);
  let frac = Math.round((stage - i) * 255);
  let r = i;
  if (frac > 255) { frac = 0; r = i + 1; } // rounding carried over
  return [r, frac];
}

/** Inverse of encodeStageBytes. */
export function decodeStageBytes(r: number, g: number): number {
  return r + g / 255;
}
