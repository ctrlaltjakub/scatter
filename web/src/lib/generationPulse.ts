export const GENERATION_PULSE_MS = 1400;

/** Negative delay that places a newly activated leaf on the shared clock. */
export function generationPulseDelay(now?: number): string {
  const clock = now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const phase = ((clock % GENERATION_PULSE_MS) + GENERATION_PULSE_MS) % GENERATION_PULSE_MS;
  return `${-phase}ms`;
}
