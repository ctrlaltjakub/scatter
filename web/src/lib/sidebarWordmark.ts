export interface WordmarkGlyphStyle {
  color: string;
  brightness: number;
}

const WORDMARK_LENGTH = 7;

function uniqueColors(palette: readonly string[]): string[] {
  return [...new Set(palette.filter(Boolean))];
}

function validNextColor(colors: readonly string[], candidate: string): boolean {
  const next = [...colors, candidate];
  const runs: Array<{ start: number; length: number }> = [];
  let start = 0;
  for (let index = 1; index <= next.length; index += 1) {
    if (index < next.length && next[index] === next[start]) continue;
    runs.push({ start, length: index - start });
    start = index;
  }

  if (runs.some(({ length }) => length > 2)) return false;
  const pairs = runs.filter(({ length }) => length === 2);
  if (pairs.length > 2) return false;
  for (let index = 1; index < pairs.length; index += 1) {
    const previous = pairs[index - 1]!;
    const current = pairs[index]!;
    if (current.start - (previous.start + previous.length) < 1) return false;
  }
  return true;
}

/** Build the seven per-letter styles for the SCATTER sidebar wordmark. */
export function generateWordmarkPattern(
  palette: readonly string[],
  rng: () => number = Math.random,
): WordmarkGlyphStyle[] {
  const colors = uniqueColors(palette);
  if (colors.length === 0) {
    return Array.from({ length: WORDMARK_LENGTH }, () => ({
      color: 'var(--text)',
      brightness: 1,
    }));
  }

  if (colors.length === 1) {
    return Array.from({ length: WORDMARK_LENGTH }, () => ({
      color: colors[0]!,
      brightness: 0.92 + rng() * 0.16,
    }));
  }

  const chosen: string[] = [];
  while (chosen.length < WORDMARK_LENGTH) {
    const candidates = colors.filter((color) => validNextColor(chosen, color));
    chosen.push(candidates[Math.floor(rng() * candidates.length)]!);
  }
  return chosen.map((color) => ({ color, brightness: 1 }));
}
