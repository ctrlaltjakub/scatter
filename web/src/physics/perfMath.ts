/**
 * PERF #7 — `Math.hypot` is spec'd to handle overflow/underflow with
 * extended-precision intermediate math. That makes it correct for the
 * full f64 range but ~2-4× slower than a direct sqrt.
 *
 * Our coordinate range is bounded: nodes live in roughly ±10⁶ canvas
 * pixels at worst, so per-axis values square to ≤ 10¹² — well inside
 * f64's safe integer range (2⁵³ ≈ 9×10¹⁵). No overflow is possible.
 *
 * Use `fastHypot` everywhere in `forces.ts`, `verletRope.ts`,
 * `routePath.ts`. The wins compound across the inner loops (per-pair
 * distance, per-segment length, per-anchor smoothing, A* heuristic).
 */
export function fastHypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
