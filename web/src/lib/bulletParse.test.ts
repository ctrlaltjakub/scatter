import { describe, expect, test } from 'vitest';
import { LANGUAGES } from './languages';
import { parseBody, sanitizeBody, freshOutlineProblem, unboldFreshDescriptions, separatorColonIndex, bulletsToPlainText, stabilizeParsed } from './bulletParse';

describe('fresh encyclopedic outlines', () => {
  const outline = (opening = 4, sections = 3, children = 2) =>
    [Array.from({ length: opening }, () => 'Dr. A. B. Rao measures **2.5 cm**.').join('\n'), '',
      ...Array.from({ length: sections }, (_, n) => [`- Section ${n}`,
        ...Array.from({ length: children }, () => '  - Term: A definition.')].join('\n'))].join('\n');
  test('accepts the minimum and maximum, with one plain sentence per description', () => {
    expect(freshOutlineProblem(outline())).toBeNull();
    expect(freshOutlineProblem(outline(6, 10, 10))).toBeNull();
  });
  test.each([[3,3,2], [7,3,2], [4,2,2], [4,11,2], [4,3,1], [4,3,11]])(
    'rejects out-of-bounds counts (%i, %i, %i)', (i, m, c) => expect(freshOutlineProblem(outline(i,m,c))).not.toBeNull());
  test('checks each section and description, not only the first two', () => {
    expect(freshOutlineProblem(outline().replace('cm**.\nDr.', 'cm**.\n\nDr.'))).toContain('one paragraph');
    expect(freshOutlineProblem(outline() + '\n- Another\n  - Single: Only one.')).toContain('Main bullet 4');
    expect(freshOutlineProblem(outline() + '\n  - No description')).toContain('description');
    expect(freshOutlineProblem(outline().replace('A definition.', '⟦2⟧.'))).toContain('description');
    expect(freshOutlineProblem(outline() + '\n    Second.\n    Third.')).toContain('one sentence');
    expect(freshOutlineProblem(outline().replace('  - Term:', '  - [[A: B]]:'))).toBeNull();
  });
  test.each(LANGUAGES)('accepts the source-line format in $name', ({sample}) => {
    const localized = outline(4, 3, 2)
      .replaceAll('Dr. A. B. Rao measures **2.5 cm**.', sample)
      .replaceAll('A definition.', sample);
    expect(freshOutlineProblem(localized)).toBeNull();
  });
  test.each(['An extra fact. Another fact.', '水是液体。冰是固体。', 'पानी जमता है। बर्फ पिघलती है।', 'ما الفرق؟ يتغير السائل.'])(
    'rejects clear extra sentences on one bullet line: %s', text => {
      expect(freshOutlineProblem(outline().replace('A definition.', text))).toContain('one sentence');
    });
  test.each(['Dr. A. B. Rao measured 2.5 cm.', 'Dr. Richard D. Stith Jr. studied U.S. birds.',
    'According to Prof. H. G. Wells, it is solid.⟦2⟧', 'The question “What happens?” motivates the experiment.', 'At 10:30 a.m. Elm St. opens.',
    'أجرى د. علي الاختبار.', 'डॉ. राव ने परिणाम मापा।', 'Compare `x.y` at https://example.org/a.b.'])(
    'does not request paid repair for an abbreviation, citation or literal: %s', text => {
      expect(freshOutlineProblem(outline().replace('A definition.', text))).toBeNull();
    });
  test('removes only bold in generated descriptions; keeps titles, clickable terms, emphasis and citations', () => {
    const decorated = outline().replace('Term: A definition.', '**Term:** A **[[definition]]** and __a fact__⟦2⟧.');
    expect(freshOutlineProblem(decorated)).toContain('bold');
    const plain = unboldFreshDescriptions(decorated);
    expect(plain).toBe(decorated.replace('**[[definition]]** and __a fact__', '[[definition]] and a fact'));
    expect(freshOutlineProblem(plain)).toBeNull();
    expect(unboldFreshDescriptions('  - **Name: fact** and `**literal**`.')).toBe('  - **Name**: fact and `**literal**`.');
    expect(unboldFreshDescriptions('  - Name: ***emphasis*** remains.')).toBe('  - Name: *emphasis* remains.');
    expect(unboldFreshDescriptions(plain)).toBe(plain);
  });
  test.each(['أجرى د. علي الاختبار.', '水には H₂O が含まれる。', 'डॉ. राव ने `x.y` मापा।', 'L’eau gèle à 0 °C.'])(
    'counts source lines without splitting on punctuation: %s', sentence => {
      expect(freshOutlineProblem(outline().replaceAll('Dr. A. B. Rao measures **2.5 cm**.', sentence))).toBeNull();
    });
});

describe('sanitizeBody — strips markdown the renderer cannot display', () => {
  test('strips leading heading markers but keeps the text', () => {
    expect(sanitizeBody('### Heading\nbody')).toBe('Heading\nbody');
    expect(sanitizeBody('# Big\n## Med')).toBe('Big\nMed');
  });

  test('strips leading blockquote markers', () => {
    expect(sanitizeBody('> quoted line')).toBe('quoted line');
  });

  test('turns a blockquoted bullet into a real bullet', () => {
    expect(sanitizeBody('> - item')).toBe('- item');
    expect(sanitizeBody('>   - x: y')).toBe('  - x: y');
  });

  test('leaves indentation, [[chips]] and emphasis untouched', () => {
    expect(sanitizeBody('  - [[Foo]]: **bar**')).toBe('  - [[Foo]]: **bar**');
  });
});

describe('parseBody — sanitizes stray markdown before parsing', () => {
  test('a leading ### heading is cleaned out of the free text', () => {
    const r = parseBody('### Photosynthesis\n\n- A\n  - x: y')!;
    expect(r.freeText).toBe('Photosynthesis');
    expect(r.bullets).toHaveLength(1);
  });
});

describe('parseBody — happy path', () => {
  test('parses opening + two-level bullets with colon separator', () => {
    const md = `An intro paragraph about [[React]].

- React fundamentals
  - Components: reusable UI building blocks
  - State: tracks dynamic data
- Hooks
  - useState: local component state
  - useEffect: side effects after render`;

    const result = parseBody(md);
    expect(result).not.toBeNull();
    expect(result!.freeText).toBe('An intro paragraph about [[React]].');
    expect(result!.bullets).toHaveLength(2);
    expect(result!.bullets[0]).toEqual({
      title: 'React fundamentals',
      children: [
        { name: 'Components', desc: 'reusable UI building blocks' },
        { name: 'State', desc: 'tracks dynamic data' },
      ],
    });
    expect(result!.bullets[1]!.title).toBe('Hooks');
    expect(result!.bullets[1]!.children).toHaveLength(2);
  });

  test('preserves [[refs]] in title, name, description', () => {
    const md = `intro.

- About [[React]]
  - [[Components]]: built on [[JSX]]`;
    const r = parseBody(md)!;
    expect(r.bullets[0]!.title).toBe('About [[React]]');
    expect(r.bullets[0]!.children[0]!.name).toBe('[[Components]]');
    expect(r.bullets[0]!.children[0]!.desc).toBe('built on [[JSX]]');
  });

  test('description containing colons keeps them after the first', () => {
    const md = `intro.

- Topic
  - Foo: see http://example.com: details follow`;
    const r = parseBody(md)!;
    expect(r.bullets[0]!.children[0]!.name).toBe('Foo');
    expect(r.bullets[0]!.children[0]!.desc).toBe('see http://example.com: details follow');
  });

  test('colon INSIDE a chip does not split the name (chip-aware)', () => {
    const md = `intro.

- Films
  - [[2001: A Space Odyssey]]: a 1968 film
  - [[Blade Runner]]: a 1982 film`;
    const r = parseBody(md)!;
    expect(r.bullets[0]!.children[0]!.name).toBe('[[2001: A Space Odyssey]]');
    expect(r.bullets[0]!.children[0]!.desc).toBe('a 1968 film');
  });

  test('separatorColonIndex skips colons inside [[ ]] spans', () => {
    expect(separatorColonIndex('Foo: bar')).toBe(3);
    expect(separatorColonIndex('[[2001: A Space Odyssey]]: a film')).toBe(25);
    expect(separatorColonIndex('[[no colon here]] no sep')).toBe(-1);
    expect(separatorColonIndex('[[unbalanced bracket: x')).toBe(20);
  });

  test('bulletsToPlainText reconstructs clean copy text (no chips/marks)', () => {
    const md = `An [[intro]] paragraph.

- About [[React]]
  - [[Components]]: built on [[JSX]]
  - State: data over time`;
    const out = bulletsToPlainText(parseBody(md)!);
    expect(out).toBe(
      'An intro paragraph.\n\n- About React\n  - Components: built on JSX\n  - State: data over time',
    );
    expect(out).not.toContain('[[');
    expect(out).not.toContain('•');
  });

  test('handles body with no bullets (free text only)', () => {
    const md = `Just an intro paragraph, no bullets.`;
    const result = parseBody(md);
    expect(result).not.toBeNull();
    expect(result!.freeText).toBe('Just an intro paragraph, no bullets.');
    expect(result!.bullets).toEqual([]);
  });

  test('accepts asterisk, dash, plus as bullet marker', () => {
    const md = `intro.

* A
  * x: y
- B
  - p: q
+ C
  + m: n`;
    const r = parseBody(md);
    expect(r).not.toBeNull();
    expect(r!.bullets).toHaveLength(3);
  });
});

describe('parseBody — lenient handling of real AI output', () => {
  test('preserves emphasis in titles, names, and descriptions for rendering', () => {
    const md = `Intro paragraph.

- **Process steps**
  - **Substrate**: glucose or other [[sugars]]
  - **Enzymes**: lactate dehydrogenase`;
    const r = parseBody(md)!;
    expect(r.bullets[0]!.title).toBe('**Process steps**');
    expect(r.bullets[0]!.children[0]!.name).toBe('**Substrate**');
    expect(r.bullets[0]!.children[0]!.desc).toBe('glucose or other [[sugars]]');
  });

  test('keeps emphasis balanced around a name/description separator', () => {
    const r = parseBody('- *Therapy*\n  - ***Therapist:*** a *professional*\n  - _Care: ongoing support_')!;
    expect(r.bullets[0]?.title).toBe('*Therapy*');
    expect(r.bullets[0]?.children).toEqual([
      { name: '***Therapist***', desc: 'a *professional*' },
      { name: '_Care_', desc: '_ongoing support_' },
    ]);
  });

  test('level-2 without colon becomes name with empty description', () => {
    const md = `Intro.

- Topic
  - just-a-name
  - another: with desc`;
    const r = parseBody(md)!;
    expect(r.bullets[0]!.children[0]).toEqual({ name: 'just-a-name', desc: '' });
    expect(r.bullets[0]!.children[1]).toEqual({ name: 'another', desc: 'with desc' });
  });

  test('three-level nesting flattens deeper items into the level-2 child list', () => {
    const md = `Intro.

- Topic
  - Subtopic: short
    - Detail A
    - Detail B`;
    const r = parseBody(md)!;
    // All indented bullets — regardless of depth — become level-2 children
    // of the current level-1 bullet. This matches real-world AI markdown
    // (Gemini and GPT both pick 4-space indentation often), and produces
    // a usable list rather than dropping content.
    expect(r.bullets[0]!.children).toHaveLength(3);
    expect(r.bullets[0]!.children.map((c) => c.name)).toEqual(['Subtopic', 'Detail A', 'Detail B']);
  });

  test('orphan level-2 lines are skipped, not treated as parser failure', () => {
    const md = `Intro.

  - orphan: x
- Real
  - child: y`;
    const r = parseBody(md);
    expect(r).not.toBeNull();
    expect(r!.bullets).toHaveLength(1);
    expect(r!.bullets[0]!.title).toBe('Real');
  });

  test('continuation lines (indented prose) append to last child desc', () => {
    const md = `Intro.

- Topic
  - Subtopic: starts here
    and continues onto a wrapped line`;
    const r = parseBody(md)!;
    expect(r.bullets[0]!.children[0]!.desc).toBe('starts here and continues onto a wrapped line');
  });

  test('mid-list prose paragraph is silently skipped', () => {
    const md = `Intro.

- Topic A
  - x: 1

This is some interjected prose that confuses the AI.

- Topic B
  - y: 2`;
    const r = parseBody(md)!;
    expect(r.bullets).toHaveLength(2);
    expect(r.bullets[0]!.title).toBe('Topic A');
    expect(r.bullets[1]!.title).toBe('Topic B');
  });

  test('one bullet still produces a usable ParsedBody', () => {
    const md = `Solo.

- The only bullet
  - one: thing`;
    const r = parseBody(md)!;
    expect(r.bullets).toHaveLength(1);
    expect(r.bullets[0]!.children).toHaveLength(1);
  });

  test('parses real Gemini output with 4-space indentation and asterisk markers', () => {
    const md = `[[Lactic acid fermentation]] is an [[anaerobic]] [[metabolic process]].

* [[Biochemical pathways]]
    * [[Glycolysis]]: The initial stage where [[glucose]] is broken down into two [[pyruvate]] molecules.
    * [[Homolactic fermentation]]: A pathway where [[lactic acid]] is the sole end product.
* [[Microbiological agents]]
    * [[Lactic acid bacteria]]: A clade of [[Gram-positive]] [[microorganisms]].
    * [[Starter cultures]]: Specific [[microbial]] strains added to raw ingredients.`;
    const r = parseBody(md)!;
    expect(r.bullets).toHaveLength(2);
    expect(r.bullets[0]!.title).toBe('[[Biochemical pathways]]');
    expect(r.bullets[0]!.children).toHaveLength(2);
    expect(r.bullets[0]!.children[0]!.name).toBe('[[Glycolysis]]');
    expect(r.bullets[0]!.children[0]!.desc).toContain('initial stage');
    expect(r.bullets[1]!.title).toBe('[[Microbiological agents]]');
    expect(r.bullets[1]!.children).toHaveLength(2);
  });
});

describe('stabilizeParsed — preserve object identities across re-parses', () => {
  const BODY = `Opening paragraph.

- Alpha
  - a1: first thing
  - a2: second thing
- Beta
  - b1: third thing`;

  test('identical re-parse returns the PREVIOUS object itself', () => {
    const prev = parseBody(BODY);
    const next = parseBody(BODY);
    expect(next).not.toBe(prev); // parseBody always mints new objects
    expect(stabilizeParsed(prev, next)).toBe(prev);
  });

  test('one changed bullet: only that bullet gets a new identity', () => {
    const prev = parseBody(BODY)!;
    const next = parseBody(BODY.replace('third thing', 'third [[thing]]'))!;
    const out = stabilizeParsed(prev, next)!;
    expect(out).not.toBe(prev);
    expect(out.bullets[0]).toBe(prev.bullets[0]); // untouched → reused
    expect(out.bullets[1]).not.toBe(prev.bullets[1]); // changed → new
    expect(out.bullets[1]!.children[0]!.desc).toContain('[[thing]]');
  });

  test('freeText-only change: ALL bullets and the bullets ARRAY keep identity', () => {
    const prev = parseBody(BODY)!;
    const next = parseBody(BODY.replace('Opening', '[[Opening]]'))!;
    const out = stabilizeParsed(prev, next)!;
    expect(out).not.toBe(prev);
    expect(out.freeText).toContain('[[Opening]]');
    expect(out.bullets).toBe(prev.bullets);
  });

  test('appended bullet: prior bullets keep identity, new one is added', () => {
    const prev = parseBody(BODY)!;
    const next = parseBody(`${BODY}\n- Gamma\n  - g1: fourth thing`)!;
    const out = stabilizeParsed(prev, next)!;
    expect(out.bullets).toHaveLength(3);
    expect(out.bullets[0]).toBe(prev.bullets[0]);
    expect(out.bullets[1]).toBe(prev.bullets[1]);
    expect(out.bullets[2]!.title).toBe('Gamma');
  });

  test('changed child count on a bullet → new identity for that bullet', () => {
    const prev = parseBody(BODY)!;
    const next = parseBody(BODY.replace('  - a2: second thing\n', ''))!;
    const out = stabilizeParsed(prev, next)!;
    expect(out.bullets[0]).not.toBe(prev.bullets[0]);
    expect(out.bullets[1]).toBe(prev.bullets[1]);
  });

  test('null prev or null next pass through', () => {
    const next = parseBody(BODY);
    expect(stabilizeParsed(null, next)).toBe(next);
    expect(stabilizeParsed(next, null)).toBe(null);
  });
});
