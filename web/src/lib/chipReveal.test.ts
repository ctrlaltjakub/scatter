import { describe, expect, test } from 'vitest';
import { plain, validateChips } from './chipReveal';

describe('plain', () => {
  test('strips only [[ ]] markers, keeps **bold**, whitespace, newlines', () => {
    expect(plain('a [[chip]] b')).toBe('a chip b');
    expect(plain('**bold** [[x]]\n  - y')).toBe('**bold** x\n  - y');
    expect(plain('no chips here')).toBe('no chips here');
  });
});

describe('validateChips — accept insertion, reject disasters', () => {
  const base = 'Cells use mitochondria to make energy from food.';

  test('accepts a clean chip-insertion', () => {
    const acc = 'Cells use [[mitochondria]] to make [[energy]] from food.';
    expect(validateChips(acc, base)).toBe(acc);
  });

  test('rejects empty / whitespace output -> base', () => {
    expect(validateChips('', base)).toBe(base);
    expect(validateChips('   \n ', base)).toBe(base);
  });

  test('rejects nested brackets -> base', () => {
    expect(validateChips('Cells use [[ [[mitochondria]] ]] here.', base)).toBe(base);
  });

  test('rejects unbalanced brackets (truncated mid-chip) -> base', () => {
    expect(validateChips('Cells use [[mitochondria to make energy', base)).toBe(base);
  });

  test('rejects wholesale rewrite / preamble (length way off) -> base', () => {
    expect(validateChips('Sure! Here is your annotated text, I hope it helps a lot more text', base)).toBe(base);
    expect(validateChips('[[Cells]].', base)).toBe(base);
  });

  test('rejects a TRUNCATED output (balanced, in-ratio, but cut mid-text) -> base', () => {
    // ~80% of the body, ends after a closed chip — plain ratio check alone would
    // accept; the shortfall+missing-ending guard rejects it (truncation).
    const truncated = 'Cells use [[mitochondria]] to make [[energy]] from';
    expect(validateChips(truncated, base)).toBe(base);
  });

  test('rejects even minor rewording and keeps the exact original', () => {
    const reworded = 'Cells use [[mitochondria]] to make [[energy]] from [[nutrients]].';
    expect(validateChips(reworded, base)).toBe(base);
  });

  test('restores bold markers removed by the model while retaining its chips', () => {
    const boldBase = '- **Calvin cycle**\n  - enzyme: **RuBisCO** fixes carbon.';
    const model = '- [[Calvin cycle]]\n  - enzyme: [[RuBisCO]] fixes carbon.';
    expect(validateChips(model, boldBase)).toBe(
      '- **[[Calvin cycle]]**\n  - enzyme: **[[RuBisCO]]** fixes carbon.',
    );
  });

  test('keeps original strong formatting when the model adds or moves it', () => {
    const original = '__Alpha__ and beta stay exactly here.';
    expect(validateChips('[[**Alpha**]] and [[beta]] stay exactly here.', original)).toBe(
      '__[[Alpha]]__ and [[beta]] stay exactly here.',
    );
  });

  test('preserves every non-emphasis byte including citations and spacing', () => {
    const original = '**Energy**  follows ⟦1⟧.\n\n- **ATP**: usable energy';
    const model = '[[Energy]]  follows ⟦1⟧.\n\n- [[ATP]]: usable energy';
    const result = validateChips(model, original);
    expect(plain(result)).toBe(original);
    expect(result).toBe('**[[Energy]]**  follows ⟦1⟧.\n\n- **[[ATP]]**: usable energy');
  });

  test('rejects deleted bold content rather than deleting it from the node', () => {
    const original = 'Keep **all these words** in place.';
    expect(validateChips('Keep [[these words]] in place.', original)).toBe(original);
  });
});
