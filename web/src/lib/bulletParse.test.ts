import { describe, expect, test } from 'vitest';
import { parseBody, sanitizeBody, isValidStructure, separatorColonIndex, bulletsToPlainText, stabilizeParsed } from './bulletParse';

describe('isValidStructure — ≥2 L1 bullets each with ≥2 L2 children', () => {
  test('accepts a well-formed two-level body', () => {
    const md = `intro.
- One
  - a: x
  - b: y
- Two
  - c: x
  - d: y`;
    expect(isValidStructure(md)).toBe(true);
  });
  test('rejects a single level-1 bullet (even if it has children)', () => {
    const md = `intro.
- Only
  - a: x
  - b: y`;
    expect(isValidStructure(md)).toBe(false);
  });
  test('rejects when a level-1 bullet has fewer than 2 children', () => {
    const md = `intro.
- One
  - a: x
- Two
  - c: x`;
    expect(isValidStructure(md)).toBe(false);
  });
  test('rejects a flat list with no level-2 children', () => {
    expect(isValidStructure('intro.\n- One\n- Two\n- Three')).toBe(false);
  });
  test('rejects a body with no bullets', () => {
    expect(isValidStructure('just a paragraph, no bullets')).toBe(false);
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
