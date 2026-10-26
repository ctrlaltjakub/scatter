import type { Bullet } from './bulletParse';
import { termLabel } from './termLabel';

/**
 * Remove every `[[`/`]]` chip marker, keeping the inner text (and any
 * `**bold**`). Bullet titles and level-2 names render as WHOLE clickable terms
 * rather than the AI's partial `[[ ]]` markings, so we strip those markings on
 * render — robust regardless of what the model emits.
 *
 *   "The [[Krebs cycle]] in cells" → "The Krebs cycle in cells"
 *   "[[**One**]]"                  → "**One**"
 */
export function stripChipMarkers(text: string): string {
  return text.replace(/\[\[/g, '').replace(/\]\]/g, '');
}

/**
 * The clean term for a whole title / name: markers + emphasis stripped, trimmed.
 * This is what we spawn with, store as the arrow `label`, and look up the
 * explored state by.
 *
 *   "[[**One**]]" → "One"
 */
export function wholeTerm(text: string): string {
  return termLabel(stripChipMarkers(text)).text.trim();
}

/**
 * Index of the first bullet "containing" `term`, or null. Matches the new
 * whole-title / whole-name terms (a bullet's title or a child's name, with
 * markers stripped, equals the term) AND a legacy literal `[[term]]` inside any
 * title / name / desc (kept for description chips and older arrows). Used to
 * expand a parent bullet when a child spawned from it gains focus.
 */
export function findBulletIdxContainingTerm(bullets: Bullet[], term: string): number | null {
  const needle = `[[${term}]]`;
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i]!;
    if (wholeTerm(b.title) === term || b.title.includes(needle)) return i;
    for (const c of b.children) {
      if (wholeTerm(c.name) === term || c.name.includes(needle) || c.desc.includes(needle)) return i;
    }
  }
  return null;
}
