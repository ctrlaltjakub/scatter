import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { buildExtensions } from './editorExtensions';
import { bodyToDoc, docToBody } from '@/lib/editorSerialize';

const schemaFor = (type: string) => getSchema(buildExtensions(type as never));

/** Build the doc JSON, instantiate it against the real schema, and validate. */
function validate(body: string, type = 'root', header = 'T') {
  const schema = schemaFor(type);
  const node = schema.nodeFromJSON(bodyToDoc(body, type as never, header));
  node.check(); // throws if the content violates the schema
  return node;
}

describe('editor schema ⇄ serializer agreement', () => {
  it('a regular body produces a schema-valid doc', () => {
    const body = 'Intro **bold** [[term]].\n\n- A\n  - n: d\n\n- B\n  - m: e';
    expect(() => validate(body, 'root')).not.toThrow();
  });

  it('an explain body produces a schema-valid doc with no bullet section', () => {
    const node = validate('Just prose with a [[term]].', 'explain');
    expect(node.childCount).toBe(2); // title + freeTextSection
  });

  it('a regular body with no bullets still validates (forced empty bullet section)', () => {
    expect(() => validate('Only intro text.', 'root')).not.toThrow();
  });

  it('round-trips body → schema node → body unchanged', () => {
    const body = 'Intro.\n\n- First\n  - a: 1\n  - b: 2\n\n- Second\n  - c: 3';
    const node = validate(body, 'root');
    expect(docToBody(node.toJSON())).toBe(body);
  });

  it('schema forbids marks where it should (bullets term-only, no bold)', () => {
    const schema = schemaFor('root');
    const bold = schema.marks.bold!;
    const term = schema.marks.term!;
    // Free text: bold + term allowed.
    expect(schema.nodes.paragraph!.allowsMarkType(bold)).toBe(true);
    expect(schema.nodes.paragraph!.allowsMarkType(term)).toBe(true);
    // Bullet lines (l2Item) + L1 titles: term only, never bold.
    expect(schema.nodes.l2Item!.allowsMarkType(bold)).toBe(false);
    expect(schema.nodes.l2Item!.allowsMarkType(term)).toBe(true);
    expect(schema.nodes.l1Title!.allowsMarkType(bold)).toBe(false);
    expect(schema.nodes.l1Title!.allowsMarkType(term)).toBe(true);
    // Article title: no inline marks.
    expect(schema.nodes.title!.allowsMarkType(bold)).toBe(false);
  });
});
