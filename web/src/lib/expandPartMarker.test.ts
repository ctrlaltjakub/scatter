/**
 * Tests for `locateSection` — the helper that finds the char-range
 * boundaries of a freetext or L1-bullet section within a body
 * string. Used by `expandPart` to (a) animate the section's deletion
 * and (b) splice in the LLM's replacement.
 *
 * `body.slice(start, end)` must equal exactly the section text; the
 * concatenation of `body.slice(0, start) + body.slice(end)` must
 * be the body with the section cleanly removed (no orphaned blank
 * lines collapsing into the wrong place).
 */
import { describe, it, expect } from 'vitest';
import { locateSection, extractSectionFromLLM } from './generate';

const SAMPLE = [
  'Lactic fermentation converts [[glucose]] to [[lactic acid]] without oxygen.',
  '',
  '- Process',
  '  - Substrate: [[glucose]] from carbohydrates',
  '  - Enzyme: [[lactate dehydrogenase]] catalyzes the reaction',
  '- Conditions',
  '  - Anaerobic: occurs when [[oxygen]] is limited',
  '  - Cells: [[fast-twitch fibers]] during sprints',
  '- Applications',
  '  - Food: [[yogurt]], [[sauerkraut]], [[kimchi]]',
].join('\n');

describe('locateSection — freetext target', () => {
  it('returns the char-range covering the opening paragraph only', () => {
    const r = locateSection(SAMPLE, { kind: 'freetext' });
    expect(r).not.toBeNull();
    const { start, end } = r!;
    expect(start).toBe(0);
    const section = SAMPLE.slice(start, end);
    expect(section).toBe('Lactic fermentation converts [[glucose]] to [[lactic acid]] without oxygen.');
    // After removing the section the blank-line separator + bullets
    // should still be intact.
    const remainder = SAMPLE.slice(0, start) + SAMPLE.slice(end);
    expect(remainder.startsWith('\n\n- Process')).toBe(true);
  });

  it('returns null when there is no freetext (bullet-only body)', () => {
    const bulletsOnly = ['- A', '  - x: y', '- B', '  - z: w'].join('\n');
    expect(locateSection(bulletsOnly, { kind: 'freetext' })).toBeNull();
  });
});

describe('locateSection — bullet target (L2-children-only)', () => {
  // The bullet target now covers ONLY the L2 children — the L1
  // title line stays unchanged outside the markers per user spec.
  it('covers the targeted bullet\'s L2 children, NOT its L1 title', () => {
    const r = locateSection(SAMPLE, { kind: 'bullet', index: 1 });
    expect(r).not.toBeNull();
    const section = SAMPLE.slice(r!.start, r!.end);
    expect(section).toBe(
      '  - Anaerobic: occurs when [[oxygen]] is limited\n  - Cells: [[fast-twitch fibers]] during sprints'
    );
    // The L1 title "- Conditions" must be OUTSIDE the marker.
    expect(section).not.toContain('- Conditions');
    const remainder = SAMPLE.slice(0, r!.start) + SAMPLE.slice(r!.end);
    expect(remainder).toContain('- Conditions');
    expect(remainder).toContain('- Process');
    expect(remainder).toContain('- Applications');
  });

  it('covers the first bullet\'s L2 children only, freetext + L1 stay before', () => {
    const r = locateSection(SAMPLE, { kind: 'bullet', index: 0 });
    const section = SAMPLE.slice(r!.start, r!.end);
    expect(section).toMatch(/^ {2}- Substrate/);
    expect(section).toContain('  - Enzyme:');
    expect(section).not.toContain('- Process'); // L1 outside markers
    expect(section).not.toContain('- Conditions');
    const before = SAMPLE.slice(0, r!.start);
    expect(before).toContain('Lactic fermentation');
    expect(before).toContain('- Process');
  });

  it('covers the last bullet\'s L2 children, L1 stays in remainder', () => {
    const r = locateSection(SAMPLE, { kind: 'bullet', index: 2 });
    const section = SAMPLE.slice(r!.start, r!.end);
    expect(section).toMatch(/^ {2}- Food/);
    expect(section).not.toContain('- Applications');
    const before = SAMPLE.slice(0, r!.start);
    expect(before).toContain('- Applications');
  });

  it('returns null when the index is out of range', () => {
    expect(locateSection(SAMPLE, { kind: 'bullet', index: 99 })).toBeNull();
  });

  it('handles a bullet with no L2 children: zero-length range right after the L1', () => {
    const body = 'opening prose.\n\n- Childless\n- Next L1\n  - x: y';
    const r = locateSection(body, { kind: 'bullet', index: 0 });
    expect(r).not.toBeNull();
    expect(r!.end).toBe(r!.start); // zero-length: nothing to delete
    // The position is right after the L1 line + its trailing \n.
    // Splicing new content at this offset puts it as the first L2
    // child line, which is exactly what the user wants.
    expect(body.slice(r!.start)).toMatch(/^- Next L1/);
  });

  it('section text concatenated with remainder reconstructs the body', () => {
    for (let i = 0; i < 3; i++) {
      const r = locateSection(SAMPLE, { kind: 'bullet', index: i });
      const reconstructed = SAMPLE.slice(0, r!.start) + SAMPLE.slice(r!.start, r!.end) + SAMPLE.slice(r!.end);
      expect(reconstructed).toBe(SAMPLE);
    }
  });
});

/**
 * `extractSectionFromLLM` clamps the LLM's output to JUST the
 * targeted section, no matter how much surrounding context the
 * model echoes. These tests verify the structural-boundary logic
 * for both target kinds, the streaming-friendly partial-output
 * case, and the well-behaved (model-only-output-the-section) case.
 */
/**
 * Bullet-marker leniency: the body parser (`bulletParse`) accepts
 * any of `-`, `*`, or `+` as L1 markers. `locateSection` and
 * `extractSectionFromLLM` must accept the same set, or a body
 * where the LLM used `*` or `+` will be treated as having no
 * bullets — causing the freetext target to grab the WHOLE body
 * (and delete it) and the bullet target to return null (silently
 * failing to fire). Both were real user-reported symptoms.
 */
describe('locateSection — accepts all bulletParse marker styles', () => {
  for (const marker of ['-', '*', '+']) {
    it(`finds sections when L1 marker is "${marker}"`, () => {
      const body = [
        'Opening paragraph here.',
        '',
        `${marker} First bullet`,
        '  - sub: detail',
        `${marker} Second bullet`,
        '  - sub: detail',
      ].join('\n');
      const ft = locateSection(body, { kind: 'freetext' });
      expect(ft).not.toBeNull();
      expect(body.slice(ft!.start, ft!.end)).toBe('Opening paragraph here.');
      // Bullet target wraps the L2 children, NOT the L1 title.
      const b0 = locateSection(body, { kind: 'bullet', index: 0 });
      expect(b0).not.toBeNull();
      const b0Section = body.slice(b0!.start, b0!.end);
      expect(b0Section).toBe('  - sub: detail');
      expect(b0Section).not.toContain(`${marker} First bullet`);
      const b1 = locateSection(body, { kind: 'bullet', index: 1 });
      expect(b1).not.toBeNull();
      const b1Section = body.slice(b1!.start, b1!.end);
      expect(b1Section).toBe('  - sub: detail');
      expect(b1Section).not.toContain(`${marker} Second bullet`);
    });
  }
});

describe('extractSectionFromLLM — accepts all bulletParse marker styles', () => {
  for (const marker of ['-', '*', '+']) {
    it(`clamps freetext output at the first ${marker}-bullet boundary`, () => {
      const out = `New denser freetext.\n\n${marker} Process\n  - sub: x`;
      expect(extractSectionFromLLM(out, { kind: 'freetext' })).toBe('New denser freetext.');
    });
    it(`extracts L2 children only when output uses ${marker} for L2`, () => {
      const out = `  ${marker} A: x\n  ${marker} B: y\n  ${marker} C: z`;
      expect(extractSectionFromLLM(out, { kind: 'bullet', index: 0 })).toBe(out);
    });
    it(`strips a stray L1 line if LLM accidentally echoes it (${marker})`, () => {
      const out = `${marker} L1 Echo\n  - A: x\n  - B: y`;
      expect(extractSectionFromLLM(out, { kind: 'bullet', index: 0 }))
        .toBe('  - A: x\n  - B: y');
    });
  }
});

describe('extractSectionFromLLM — freetext target', () => {
  const T = { kind: 'freetext' as const };
  it('returns the prose verbatim when LLM gave only freetext (well-behaved)', () => {
    const out = 'New, denser freetext describing [[X]] in more detail.';
    expect(extractSectionFromLLM(out, T)).toBe(out);
  });
  it('strips trailing bullets when LLM echoes the whole body', () => {
    const out = [
      'New, denser freetext describing [[X]] in more detail.',
      '',
      '- Process',
      '  - Substrate: ...',
      '- Conditions',
      '  - Anaerobic: ...',
    ].join('\n');
    expect(extractSectionFromLLM(out, T))
      .toBe('New, denser freetext describing [[X]] in more detail.');
  });
  it('returns partial output unchanged when no L1 boundary yet (streaming case)', () => {
    const partial = 'New, denser freetext describing [[X]] in';
    expect(extractSectionFromLLM(partial, T)).toBe(partial);
  });
  it('returns empty string when the output is empty', () => {
    expect(extractSectionFromLLM('', T)).toBe('');
  });
});

describe('extractSectionFromLLM — bullet target (L2-only)', () => {
  const T = { kind: 'bullet' as const, index: 0 };
  // The bullet target's expected output is ONLY L2 children — the L1
  // line stays outside the markers per user spec.
  const NEW_L2 = '  - A: x\n  - B: y\n  - C: z (new)';

  it('returns L2 children verbatim when LLM is well-behaved', () => {
    expect(extractSectionFromLLM(NEW_L2, T)).toBe(NEW_L2);
  });
  it('strips a leading L1 echo (LLM repeated the parent title)', () => {
    const out = `- Process Echo\n${NEW_L2}`;
    expect(extractSectionFromLLM(out, T)).toBe(NEW_L2);
  });
  it('strips a preamble before the first L2', () => {
    const out = `Here are the expanded children:\n${NEW_L2}`;
    expect(extractSectionFromLLM(out, T)).toBe(NEW_L2);
  });
  it('strips a trailing L1 sibling when LLM keeps writing past the section', () => {
    const out = `${NEW_L2}\n- Next L1\n  - somesibling: ...`;
    expect(extractSectionFromLLM(out, T)).toBe(NEW_L2);
  });
  it('handles whole-body echo: leading freetext + L1 + L2 + next L1', () => {
    const out = [
      'Some freetext echoed by the LLM.',
      '',
      '- Process Echo',
      NEW_L2,
      '- Next L1',
      '  - sibling: ...',
    ].join('\n');
    expect(extractSectionFromLLM(out, T)).toBe(NEW_L2);
  });
  it('returns empty when streamed output has no L2 line yet', () => {
    expect(extractSectionFromLLM('Some preamble before any bullet', T)).toBe('');
  });
  it('handles the streaming case where the next L1 is mid-emission', () => {
    const partial = NEW_L2 + '\n- Next';
    expect(extractSectionFromLLM(partial, T)).toBe(NEW_L2);
  });
});
