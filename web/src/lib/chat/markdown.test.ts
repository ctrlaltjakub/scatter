import { describe, expect, it } from 'vitest';
import { chatFactUnits, chatHasSourceCoverage } from './markdown';
import { LANGUAGES } from '@/lib/languages';

describe('chat Markdown units', () => {
  it.each(LANGUAGES)('keeps citations attached to emphasized sentences in $name', language => {
    const units = chatFactUnits(`**${language.sample}** ⟦1⟧ ${language.sample}`);
    expect(units.map(unit => unit.text)).toEqual([language.sample, language.sample]);
  });

  it('does not merge words across explicit Markdown breaks in fact-check text', () => {
    expect(chatFactUnits('The Titans sleep,\\\nSpoke the Healer.')[0]?.text).toBe('The Titans sleep,\nSpoke the Healer.');
  });
  it('checks prose and lists, excludes headings and code, and includes table column context', () => {
    const units = chatFactUnits('# A title\n\nA **first fact** is stated. A second fact follows.\n\n- A list fact is here.\n\n| Region | Count |\n| --- | --- |\n| Japan | 10 |\n| China | 20 |\n\n```js\nconst x = 1;\n```');
    expect(units.map((unit) => unit.text)).toEqual([
      'A first fact is stated.', 'A second fact follows.', 'A list fact is here.',
      'Region: Japan; Count: 10', 'Region: China; Count: 20',
    ]);
    expect(units[3]?.sectionTitle).toContain('Region | Count');
  });
  it('retains each inline term exactly and does not interpret ordinary parentheses as citations', () => {
    expect(chatFactUnits('**[[Working memory]]** lasts briefly. A number (42) is here.')[0]?.text)
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
});
