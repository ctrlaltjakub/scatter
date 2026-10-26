export const OVERVIEW_SCREEN_FONT_PX = 12;

export interface OverviewTextPiece {
  kind: 'space' | 'word';
  text: string;
  breakAfter?: boolean;
}

/**
 * Adds manual break opportunities inside one word. Soft hyphens are invisible
 * while the word fits and become a visible `-` only if its own max-width forces
 * it to wrap.
 */
function addManualHyphens(word: string): string {
  const characters = Array.from(word);
  let result = '';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const next = characters[index + 1];
    result += character;
    if (
      next
      // Do not insert discretionary hyphens into joining scripts (Arabic),
      // Indic clusters, or CJK text. Native line breaking handles those scripts.
      && /[\p{Script=Latin}\p{Script=Cyrillic}\p{N}]/u.test(character)
      && /[\p{Script=Latin}\p{Script=Cyrillic}\p{N}]/u.test(next)
    ) {
      result += '\u00ad';
    }
  }
  return result;
}

/**
 * Produces atomic word boxes for the overview header. A box that fits moves
 * whole to the next line; only a box wider than the complete line contracts
 * to the line width and uses its internal soft hyphens.
 */
export function tokenizeOverviewText(text: string): OverviewTextPiece[] {
  const pieces: OverviewTextPiece[] = [];
  for (const chunk of text.match(/\s+|[^\s]+/gu) ?? []) {
    if (/^\s+$/u.test(chunk)) {
      pieces.push({ kind: 'space', text: ' ' });
      continue;
    }

    let segment = '';
    for (const character of Array.from(chunk)) {
      segment += character;
      if (character === '/') {
        pieces.push({
          kind: 'word',
          text: addManualHyphens(segment),
          breakAfter: true,
        });
        segment = '';
      }
    }
    if (segment) {
      pieces.push({ kind: 'word', text: addManualHyphens(segment) });
    }
  }
  return pieces;
}
