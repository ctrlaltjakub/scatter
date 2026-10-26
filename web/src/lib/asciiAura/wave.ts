/**
 * Wave envelopes around a node's aura.
 *
 *   'focus' / 'spawn' — an expanding water ripple from the node
 *   border. A Gabor wavelet (cosine carrier × Gaussian envelope)
 *   gives a smooth central crest flanked by soft troughs and a faint
 *   trailing ring — the natural "drop in water" look. Amplitude
 *   decays as the crest spreads and fades to 0 at the deadline.
 *   The bonus is SIGNED; callers add it to steady density and clamp
 *   to [0, 1].
 *
 *   'unfocus' — a RECEDING ripple: the same wavelet, but the crest
 *   travels INWARD (R₀ → 0) over the unfocus fade, like water
 *   draining back to the node. Fired when a node loses focus.
 *
 *   'collapse' — fired when a node is deleted. The aura radius
 *   shrinks linearly from a captured startRadius to 0; density
 *   inside follows 1 − dist/radius with the shrinking radius.
 *   Replaces (not adds to) steady; always non-negative.
 */

/** Expanding-ripple lifetime. */
export const WAVE_DURATION_MS = 650;
/** Crest speed for the expanding ripple (px/sec). */
export const WAVE_SPEED_PX_PER_S = 280;
/** Receding-ripple lifetime — matches the unfocus alpha fade so the
 *  drain and the dim end together. */
export const UNFOCUS_DURATION_MS = 450;
/** Where the receding crest starts (px from the node border) before
 *  draining inward to 0. */
export const UNFOCUS_START_RADIUS_PX = 200;
export const COLLAPSE_DURATION_MS = 250;

/** Wavelet carrier wavelength (px) — distance between successive
 *  ripple rings. */
export const RIPPLE_WAVELENGTH_PX = 90;
/** Gaussian envelope width (px) — how many rings are visible before
 *  the wavelet fades out. */
export const RIPPLE_SIGMA_PX = 50;
/** Amplitude spatial-decay length (px): amp = A / (1 + crest/L). */
export const AMP_DECAY_LEN_PX = 240;

/** Max crest radius the expanding ripple reaches. */
const MAX_CREST_PX = WAVE_SPEED_PX_PER_S * (WAVE_DURATION_MS / 1000);
/** Furthest border-distance any ripple can contribute density to —
 *  the largest start crest plus 3σ of the Gaussian tail. The 2D
 *  renderer uses this to size each aura's sampling region so the
 *  wider ripple isn't clipped. (The GL pass samples every cell, so
 *  it needs no reach constant.) */
export const MAX_WAVE_REACH_PX = Math.max(MAX_CREST_PX, UNFOCUS_START_RADIUS_PX) + 3 * RIPPLE_SIGMA_PX;

export type Wave =
  | { kind: 'focus' | 'spawn'; t0: number }
  | { kind: 'unfocus'; t0: number }
  | { kind: 'collapse'; t0: number; startRadius: number };

export function waveStillActive(wave: Wave, nowMs: number): boolean {
  const elapsed = nowMs - wave.t0;
  // Clock-skew guard: t0 is performance.now() stamped in an input handler,
  // but the render loop asks with its rAF timestamp — stamped at frame
  // START, so routinely a few ms EARLIER than a t0 born in that same frame.
  // A wave from the "future" is newborn, not expired: answering false here
  // let pruneExpired delete focus ripples before their first painted frame
  // (and the focused flag stays true, so the ripple never re-fired).
  // Density code is safe on its own: waveDensity / the GLSL singleRipple
  // both render elapsed < 0 as 0 and start playing on the next frame.
  if (elapsed < 0) return true;
  if (wave.kind === 'collapse') return elapsed < COLLAPSE_DURATION_MS;
  if (wave.kind === 'unfocus') return elapsed < UNFOCUS_DURATION_MS;
  return elapsed < WAVE_DURATION_MS;
}

/** Gabor wavelet sampled at signed radial offset Δ from the crest.
 *  cos carrier (peak +1 at the crest) × Gaussian envelope. */
function wavelet(delta: number): number {
  const carrier = Math.cos((2 * Math.PI * delta) / RIPPLE_WAVELENGTH_PX);
  const envelope = Math.exp(-(delta * delta) / (2 * RIPPLE_SIGMA_PX * RIPPLE_SIGMA_PX));
  return carrier * envelope;
}

export function waveDensity(distFromBorder: number, wave: Wave, nowMs: number): number {
  const t = nowMs - wave.t0;
  if (t < 0) return 0;

  if (wave.kind === 'collapse') {
    if (t >= COLLAPSE_DURATION_MS) return 0;
    const radius = wave.startRadius * (1 - t / COLLAPSE_DURATION_MS);
    if (radius <= 0 || distFromBorder >= radius) return 0;
    return 1 - distFromBorder / radius;
  }

  // Expanding ('focus'/'spawn') or receding ('unfocus') ripple.
  const isReceding = wave.kind === 'unfocus';
  const duration = isReceding ? UNFOCUS_DURATION_MS : WAVE_DURATION_MS;
  if (t >= duration) return 0;
  const progress = t / duration;
  const crest = isReceding
    ? UNFOCUS_START_RADIUS_PX * (1 - progress)        // drains inward
    : WAVE_SPEED_PX_PER_S * (t / 1000);               // expands outward

  // Amplitude: spreads as the crest grows, and fades to 0 at the
  // deadline so the ripple dissolves rather than snapping off.
  const amp = (1 - progress) / (1 + crest / AMP_DECAY_LEN_PX);
  if (amp <= 0) return 0;

  return amp * wavelet(distFromBorder - crest);
}
