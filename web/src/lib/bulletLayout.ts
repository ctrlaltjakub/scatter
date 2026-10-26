import type { Bullet } from './bulletParse';

/**
 * Render modes for a bullet's nested tail. `0` = collapsed (title only),
 * `1` = inline-only (comma-separated child names on one wrapping line),
 * `k` (2 ≤ k ≤ N) = (k-1) children with descriptions + remaining N-k+1
 * inline as names, `N+1` = all N children with descriptions (no inline
 * group). The M_N → M_{N+1} transition is height-neutral.
 */
export type Mode = number;

/** Per-line height inputs (px). Caller measures or estimates. */
export interface Heights {
  title: number;     // height of a level-1 title row
  inline: number;    // height of an inline-group line (one comma-separated row)
  described: number; // height of a single described row (name: desc)
}

export function maxMode(b: Bullet): Mode {
  return b.children.length + 1;
}

export function heightOf(b: Bullet, m: Mode, h: Heights): number {
  const N = b.children.length;
  if (m <= 0) return h.title;
  if (m >= N + 1) return h.title + N * h.described;
  return h.title + (m - 1) * h.described + h.inline;
}

export function totalHeight(bullets: Bullet[], modes: Mode[], h: Heights): number {
  let t = 0;
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i]!;
    const m = modes[i] ?? 0;
    t += heightOf(b, m, h);
  }
  return t;
}

/**
 * Cascade algorithm: uniform-first target progression with top-priority
 * cascade when uniformity can't fit. Returns one Mode per bullet.
 *
 * - If `activeIdx` is set, that bullet is locked at its max mode.
 * - For target = 1, 2, …: tentatively lift every non-active bullet to
 *   `min(target, maxMode_i)`. If the lift fits, commit and continue.
 *   Otherwise, top-down, give each non-active bullet that target greedily
 *   (fits-or-stays-put), then stop.
 * - After the target loop, a free-upgrade sweep promotes any bullet whose
 *   next-mode delta is ≤ 0 (the M_N → M_{N+1} jump).
 */
export function computeModes(
  bullets: Bullet[],
  activeIdx: number | null,
  availableHeight: number,
  h: Heights,
): Mode[] {
  const N = bullets.length;
  const modes: Mode[] = new Array(N).fill(0);
  if (activeIdx !== null && activeIdx >= 0 && activeIdx < N) {
    modes[activeIdx] = maxMode(bullets[activeIdx]!);
  }

  for (let target = 1; ; target++) {
    const tentative = modes.slice();
    let anyChange = false;
    for (let i = 0; i < N; i++) {
      if (i === activeIdx) continue;
      const desired = Math.min(target, maxMode(bullets[i]!));
      if (desired > (tentative[i] ?? 0)) {
        tentative[i] = desired;
        anyChange = true;
      }
    }
    if (!anyChange) break;

    if (totalHeight(bullets, tentative, h) <= availableHeight) {
      for (let i = 0; i < N; i++) modes[i] = tentative[i] ?? 0;
    } else {
      for (let i = 0; i < N; i++) {
        if (i === activeIdx) continue;
        const b = bullets[i]!;
        const desired = Math.min(target, maxMode(b));
        const cur = modes[i] ?? 0;
        if (cur >= desired) continue;
        const delta = heightOf(b, desired, h) - heightOf(b, cur, h);
        if (totalHeight(bullets, modes, h) + delta <= availableHeight) {
          modes[i] = desired;
        }
      }
      break;
    }
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < N; i++) {
      const b = bullets[i]!;
      const cur = modes[i] ?? 0;
      const max = maxMode(b);
      if (cur >= max) continue;
      const delta = heightOf(b, cur + 1, h) - heightOf(b, cur, h);
      if (delta <= 0 && totalHeight(bullets, modes, h) + delta <= availableHeight) {
        modes[i] = cur + 1;
        progressed = true;
      }
    }
  }

  return modes;
}

/**
 * Minimum body height: any single bullet must always be expandable to its
 * full form, with free text intact and all other bullet titles visible.
 */
export function computeMinHeight(
  bullets: Bullet[],
  freeTextHeight: number,
  h: Heights,
  bodyPadding: number,
): number {
  if (bullets.length === 0) return freeTextHeight + bodyPadding;
  let worstFull = 0;
  for (const b of bullets) {
    const full = heightOf(b, maxMode(b), h);
    if (full > worstFull) worstFull = full;
  }
  const othersTitle = (bullets.length - 1) * h.title;
  return worstFull + othersTitle + freeTextHeight + bodyPadding;
}

/**
 * Initial body height for a freshly-generated node: all bullets at M1
 * (title + inline group of names).
 */
export function computeInitHeight(
  bullets: Bullet[],
  freeTextHeight: number,
  h: Heights,
  bodyPadding: number,
): number {
  let sum = 0;
  for (const b of bullets) sum += heightOf(b, 1, h);
  return sum + freeTextHeight + bodyPadding;
}
