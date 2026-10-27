import { describe, expect, it } from 'vitest';
import { LANGUAGES } from './languages';
import { explicitLineSegments, explicitLineSplitPoints, hasParagraphBreak, splitExplicitLines } from './proseLines';

describe('explicit prose lines', () => {
  it('never infers boundaries from abbreviations, initials or sentence punctuation', () => {
    const line = 'Dear **Dr. Richard D. Stith Jr.**, contact **Capt. J. B. Vance** at **St. Jude Hospital**. Another sentence stays here.';
    expect(splitExplicitLines(line)).toEqual([line]);
    expect(explicitLineSplitPoints(line)).toEqual([]);
  });

  it('keeps all six supplied abbreviation-heavy lines intact', () => {
    const lines = [
      'Dear **Dr. Richard D. Stith Jr.**, please contact **Capt. J. B. Vance** at **St. Jude Hospital** regarding Case No. 42.',
      'The urgent **consultation appt.** on **Elm St.** is confirmed for **approx. 10:30 a.m.**',
      'Please deliver the **dept. clinical records** to **Prof. H. G. Wells** at **Suite No. 7, 5th Ave.**',
      'Representatives from **Smith & Co. Ltd.** audited the **est. laboratory fees** vs. **actual billing records**.',
      'Gov. **A. E. Clark** requested **addl. sworn affidavits** from **Sen. T. R. Lee**.',
      'Please direct **all remaining corresp.** to **Mrs. M. St. Clair** at **No. 12 Park Blvd.**',
    ];
    expect(splitExplicitLines(lines.join('\n'))).toEqual(lines);
    expect(splitExplicitLines(lines.join(' '))).toEqual([lines.join(' ')]);
  });

  it.each(LANGUAGES)('respects authored boundaries in $name', ({ sample }) => {
    expect(splitExplicitLines(`${sample} ${sample}\n${sample}`)).toEqual([`${sample} ${sample}`, sample]);
    expect(splitExplicitLines(`${sample}${sample}`)).toEqual([`${sample}${sample}`]);
  });

  it('preserves raw offsets, blank-line gaps, CRLF and Unicode separators', () => {
    const source = '  First\r\n\r\n  Second\u2028Third\u2029Fourth  ';
    const lines = explicitLineSegments(source);
    expect(lines.map(line => source.slice(line.start, line.end))).toEqual(['First', 'Second', 'Third', 'Fourth']);
    expect(explicitLineSplitPoints(source)).toEqual(lines.slice(1).map(line => line.start));
    expect(hasParagraphBreak(source.slice(lines[0]!.end, lines[1]!.start))).toBe(true);
    expect(hasParagraphBreak(source.slice(lines[1]!.end, lines[2]!.start))).toBe(false);
    expect(hasParagraphBreak(source.slice(lines[2]!.end, lines[3]!.start))).toBe(true);
    expect(hasParagraphBreak('\r\n')).toBe(false);
    expect(splitExplicitLines('\n  \r\n')).toEqual([]);
  });

  it('keeps existing multiline clickable terms intact without guessing sentence breaks', () => {
    expect(splitExplicitLines('A [[Working\nmemory]] matters.\nAnother line.'))
      .toEqual(['A [[Working\nmemory]] matters.', 'Another line.']);
  });

  it('rebalances emphasis without dropping inline term or citation markers', () => {
    expect(splitExplicitLines('Before *first line\nsecond **bold** line* after.\n[[Dr. Smith]] is here.⟦1⟧'))
      .toEqual(['Before *first line*', '*second **bold** line* after.', '[[Dr. Smith]] is here.⟦1⟧']);
  });
});
