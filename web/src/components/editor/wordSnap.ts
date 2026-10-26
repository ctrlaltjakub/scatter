import type { EditorState } from '@tiptap/pm/state';

/** A "word" character — letters, numbers, underscore, across scripts. */
const WORD = /[\p{L}\p{N}_]/u;
/** Whitespace — trimmed off the selection edges before expanding. */
const SPACE = /\s/u;

/** Read the char at absolute position `pos` within its own textblock ('' if out of range). */
function charAt(state: EditorState, pos: number): string {
  const $p = state.doc.resolve(pos);
  const start = $p.start();
  const text = state.doc.textBetween(start, $p.end(), '\n', '\n');
  return text[pos - start] ?? '';
}

/**
 * Expand a (from, to) range outward to whole-word boundaries within each end's
 * own textblock. A collapsed cursor expands to the word under it. Used by the
 * "Mark as term" command and the drag-to-extend selection so term marks always
 * snap to whole words.
 *
 * Whitespace the user included at the selection edges is trimmed FIRST, so a
 * selection like "word " (trailing space) snaps to just "word" instead of
 * reaching across the space into the next word.
 */
export function expandToWordBoundaries(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } {
  let lo = Math.min(from, to);
  let hi = Math.max(from, to);
  // Drop leading/trailing whitespace from the selection (skip when collapsed).
  while (lo < hi && SPACE.test(charAt(state, lo))) lo++;
  while (hi > lo && SPACE.test(charAt(state, hi - 1))) hi--;
  const $lo = state.doc.resolve(lo);
  const $hi = state.doc.resolve(hi);

  const loStart = $lo.start();
  const loText = state.doc.textBetween(loStart, $lo.end(), '\n', '\n');
  let l = lo - loStart;
  while (l > 0 && WORD.test(loText[l - 1] ?? '')) l--;

  const hiStart = $hi.start();
  const hiText = state.doc.textBetween(hiStart, $hi.end(), '\n', '\n');
  let h = hi - hiStart;
  while (h < hiText.length && WORD.test(hiText[h] ?? '')) h++;

  return { from: loStart + l, to: hiStart + h };
}
