/**
 * Bullet-boundary commit gate for pass-1 streaming.
 *
 * Contract: the intro paragraph streams live (commit grows with every call),
 * but once the first top-level bullet starts, commits land only at L1
 * boundaries — the currently-streaming bullet (title + its children) is
 * withheld until the NEXT L1 starts (or finalize). Between boundaries next()
 * returns null (zero store writes). Committed text never shrinks; a diverged
 * accumulator (sanitizer edge) degrades safely instead of throwing.
 */
import { describe, expect, it } from 'vitest';
import { makeBulletCommitGate } from './streamCommitGate';

const INTRO = 'An intro paragraph that streams live for the reader.';

describe('makeBulletCommitGate', () => {
  it('streams the intro live, growing with every call', () => {
    const g = makeBulletCommitGate();
    expect(g.next('An intro')).toBe('An intro');
    expect(g.next('An intro paragraph')).toBe('An intro paragraph');
    expect(g.next(INTRO)).toBe(INTRO);
  });

  it('withholds a nascent trailing bullet marker from the live intro', () => {
    const g = makeBulletCommitGate();
    expect(g.next(`${INTRO}\n-`)).toBe(INTRO);
    // The '- ' completes into a started L1 → still nothing new beyond INTRO.
    expect(g.next(`${INTRO}\n- A`)).toBe(null);
  });

  it('returns null while inside a bullet and commits whole bullets at L1 boundaries', () => {
    const g = makeBulletCommitGate();
    const alpha = `${INTRO}\n\n- **Alpha**\n  - a1: one\n  - a2: two`;
    // Alpha started → only the intro (everything before Alpha) is committable.
    expect(g.next(alpha)).toBe(`${INTRO}\n\n`);
    // Streaming Alpha's children → nothing new.
    expect(g.next(`${alpha} and`)).toBe(null);
    // Beta starts → Alpha (title + all children) commits in one piece.
    const beta = `${alpha} and more\n- **Beta**`;
    expect(g.next(beta)).toBe(`${INTRO}\n\n- **Alpha**\n  - a1: one\n  - a2: two and more\n`);
    // Streaming Beta's children → nothing new again.
    expect(g.next(`${beta}\n  - b1: three`)).toBe(null);
  });

  it('handles a body that starts directly with a bullet (no intro)', () => {
    const g = makeBulletCommitGate();
    expect(g.next('- **Alpha**\n  - a1: x')).toBe(null); // nothing before Alpha
    expect(g.next('- **Alpha**\n  - a1: x\n- **Beta**')).toBe('- **Alpha**\n  - a1: x\n');
  });

  it('finalize always returns the full text, including the in-progress bullet', () => {
    const g = makeBulletCommitGate();
    const acc = `${INTRO}\n\n- **Alpha**\n  - a1: one`;
    g.next(acc);
    expect(g.finalize(acc)).toBe(acc);
  });

  it('never shrinks the committed text, even when the accumulator diverges', () => {
    const g = makeBulletCommitGate();
    const lens: number[] = [];
    const record = (r: string | null) => { if (r !== null) lens.push(r.length); };
    record(g.next('abc def ghi'));
    record(g.next('abc de'));          // diverged SHORTER (sanitizer edge)
    record(g.next('abc dexter'));      // diverged, still shorter than first commit
    record(g.next('abc dexter yz jkl')); // regrown past the previous commit
    for (let i = 1; i < lens.length; i++) expect(lens[i]!).toBeGreaterThanOrEqual(lens[i - 1]!);
    // The shrunken states were never committed:
    expect(lens).toEqual(['abc def ghi'.length, 'abc dexter yz jkl'.length]);
  });

  it('accepts * and + as L1 markers, same as the parser', () => {
    const g = makeBulletCommitGate();
    expect(g.next(`${INTRO}\n* Alpha\n  * a1: x\n+ Beta`)).toBe(`${INTRO}\n* Alpha\n  * a1: x\n`);
  });
});
