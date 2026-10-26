/**
 * Heuristic "is this a touch tablet / phone?" detection. Best-effort, not
 * perfect: iPadOS reports itself as a desktop Mac, so we fall back to the
 * "Mac + real touch points" trick; and a touchscreen laptop can trip the
 * generic coarse-pointer branch (an accepted false-positive — those users get
 * an override). Pure so it can be unit-tested with synthetic environments.
 */
export interface DeviceEnv {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** matchMedia('(pointer: coarse)').matches */
  pointerCoarse: boolean;
}

export function detectTouchTablet(env: DeviceEnv): boolean {
  const ua = env.userAgent || '';
  if (/Android/i.test(ua)) return true;
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  // iPadOS 13+ pretends to be a desktop Mac — give it away by real touch points.
  if (/Mac/i.test(env.platform) && env.maxTouchPoints > 1) return true;
  // Generic touch device: a coarse primary pointer backed by real touch.
  if (env.pointerCoarse && env.maxTouchPoints > 1) return true;
  return false;
}
