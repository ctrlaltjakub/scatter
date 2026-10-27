import { describe, expect, it } from 'vitest';
import { chatFactUnits, chatHasSourceCoverage } from './markdown';
import { LANGUAGES } from '@/lib/languages';

describe('chat Markdown units', () => {
  it.each(LANGUAGES)('keeps citations attached to emphasized sentences in $name', language => {
    const units = chatFactUnits(`**${language.sample}** ⟦1⟧\n${language.sample}`);
    expect(units.map(unit => unit.text)).toEqual([language.sample, language.sample]);
  });

  it.each(LANGUAGES)('does not infer punctuation boundaries for same-line prose in $name', language => {
    const text = `${language.sample} ${language.sample}`;
    expect(chatFactUnits(text).map(unit => unit.text)).toEqual([text]);
  });

  it('does not merge words across explicit Markdown breaks in fact-check text', () => {
    expect(chatFactUnits('The Titans sleep,\\\nSpoke the Healer.')[0]?.text).toBe('The Titans sleep,\nSpoke the Healer.');
  });
  it('checks prose and lists, excludes headings and code, and includes table column context', () => {
    const units = chatFactUnits('# A title\n\nA **first fact** is stated.\nA second fact follows.\n\n- A list fact is here.\n\n| Region | Count |\n| --- | --- |\n| Japan | 10 |\n| China | 20 |\n\n```js\nconst x = 1;\n```');
    expect(units.map((unit) => unit.text)).toEqual([
      'A first fact is stated.', 'A second fact follows.', 'A list fact is here.',
      'Region: Japan; Count: 10', 'Region: China; Count: 20',
    ]);
    expect(units[3]?.sectionTitle).toContain('Region | Count');
  });
  it('retains each inline term exactly and does not interpret ordinary parentheses as citations', () => {
    expect(chatFactUnits('**[[Working memory]]** lasts briefly.\nA number (42) is here.')[0]?.text)
      .toBe('Working memory lasts briefly.');
    expect(chatFactUnits('A number (42) is here.')[0]?.text).toContain('(42)');
  });
  it('uses clean rich-term text for fact-check units in prose, lists, and tables', () => {
    expect(chatFactUnits('The **[[God-image (*imago Dei*)]]** matters. ⟦1⟧\n\n- A [[**related** *concept*]] follows.\n\n| Concept | Meaning |\n|---|---|\n| [[**God-image** (*imago Dei*)]] | A psychological image. |').map((unit) => unit.text)).toEqual([
      'The God-image (imago Dei) matters.', 'A related concept follows.',
      'Concept: God-image (imago Dei); Meaning: A psychological image.',
    ]);
  });
  it('requires known source IDs in every prose/list/table-row unit in strict mode', () => {
    const valid = new Set(['SOURCE_1']);
    expect(chatHasSourceCoverage('A fact is provided. (SOURCE_1)', valid)).toBe(true);
    expect(chatHasSourceCoverage('A fact is provided. (SOURCE_99)', valid)).toBe(false);
    expect(chatHasSourceCoverage('- An unsupported list assertion.', valid)).toBe(false);
  });

  it('keeps source-only continuation lines with their prose and omits citation-only units', () => {
    expect(chatFactUnits('First claim.\n⟦1⟧\nSecond claim.\n(2)', new Set([2])).map(unit => unit.text))
      .toEqual(['First claim.', 'Second claim.']);
    expect(chatFactUnits('First claim.\n(SOURCE_1)\nSecond claim.\nSOURCE_2').map(unit => unit.text))
      .toEqual(['First claim.\n(SOURCE_1)', 'Second claim.\nSOURCE_2']);
    expect(chatFactUnits('⟦1⟧\n\n(SOURCE_1)')).toEqual([]);
    expect(chatHasSourceCoverage('First claim.\nSOURCE_1\nSecond claim.\nSOURCE_1', new Set(['SOURCE_1'])))
      .toBe(true);
  });

  it('does not split inline atoms or explicit breaks as if they were prose soft lines', () => {
    const units = chatFactUnits('A [long\nlink](https://example.com) and $a\nb$ remain intact.\nA second line with `code\ntext`.');
    expect(units).toHaveLength(2);
    expect(units[0]?.text).toBe('A long\nlink and a\nb remain intact.');
    expect(units[1]?.text).toBe('A second line with code\ntext.');
  });

  it('retains the six authored boundaries in abbreviation-heavy prose', () => {
    const body = [
      'Dear **Dr. Richard D. Stith Jr.**, please contact **Capt. J. B. Vance** at **St. Jude Hospital** regarding Case No. 42.',
      'The urgent **consultation appt.** on **Elm St.** is confirmed for **approx. 10:30 a.m.**',
      'Please deliver the **dept. clinical records** to **Prof. H. G. Wells** at **Suite No. 7, 5th Ave.**',
      'Representatives from **Smith & Co. Ltd.** audited the **est. laboratory fees** vs. **actual billing records**.',
      'Gov. **A. E. Clark** requested **addl. sworn affidavits** from **Sen. T. R. Lee**.',
      'Please direct **all remaining corresp.** to **Mrs. M. St. Clair** at **No. 12 Park Blvd.**',
    ];
    expect(chatFactUnits(body.join('\n')).map(unit => unit.text)).toEqual(body.map(line => line.replaceAll('**', '')));
  });

  it('uses the same visible extras as rendering without treating comments or callout syntax as claims', () => {
    const units = chatFactUnits('==A **key idea**== %%hidden\ncomment%% remains.\nA second idea.\n\n> [!note]\n> A callout claim.\n> Another callout claim.');
    expect(units.map(unit => unit.text)).toEqual(['A key idea  remains.', 'A second idea.', 'A callout claim.', 'Another callout claim.']);
    expect(units.map(unit => unit.id)).toEqual(['chat:0', 'chat:1', 'chat:2', 'chat:3']);
  });
});
