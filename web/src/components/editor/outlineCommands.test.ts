import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection, type Command } from '@tiptap/pm/state';
import { buildExtensions } from './editorExtensions';
import { bodyToDoc } from '@/lib/editorSerialize';
import { splitOutline, demoteOutline, promoteOutline, backspaceOutline, siblingMove } from './outlineCommands';

const schema = getSchema(buildExtensions('root'));

/** Build a state with the cursor inside the Nth node of a given type. */
function stateAt(body: string, typeName: string, atEnd = false, occurrence = 0): EditorState {
  const doc = schema.nodeFromJSON(bodyToDoc(body, 'root', 'T'));
  let pos = -1;
  let seen = 0;
  doc.descendants((node, p) => {
    if (pos >= 0) return false;
    if (node.type.name === typeName) {
      if (seen === occurrence) {
        pos = atEnd ? p + node.nodeSize - 1 : p + 1;
        return false;
      }
      seen++;
    }
    return true;
  });
  return EditorState.create({ schema, doc, selection: TextSelection.near(doc.resolve(pos)) });
}

function apply(state: EditorState, cmd: Command): EditorState {
  let out = state;
  cmd(state, (tr) => { out = state.apply(tr); });
  return out;
}

function count(state: EditorState, typeName: string): number {
  let n = 0;
  state.doc.descendants((node) => { if (node.type.name === typeName) n++; });
  return n;
}

function firstText(state: EditorState, typeName: string): string {
  let t = '';
  state.doc.descendants((node) => {
    if (!t && node.type.name === typeName) t = node.textContent;
  });
  return t;
}

function allTexts(state: EditorState, typeName: string): string[] {
  const out: string[] = [];
  state.doc.descendants((node) => {
    if (node.type.name === typeName) out.push(node.textContent);
  });
  return out;
}

describe('outline editing commands', () => {
  it('Enter in an L1 title adds a sibling L1', () => {
    const r = apply(stateAt('- A\n  - x: 1', 'l1Title', true), splitOutline);
    expect(count(r, 'outlineItem')).toBe(2);
  });

  it('Enter in an L2 line adds a sibling L2', () => {
    const r = apply(stateAt('- A\n  - x: 1', 'l2Item', true), splitOutline);
    expect(count(r, 'l2Item')).toBe(2);
  });

  it('Enter in a free-text paragraph is not handled (default split runs)', () => {
    expect(splitOutline(stateAt('Intro\n\n- A', 'paragraph', true))).toBe(false);
  });

  it('Tab demotes a level-1 bullet into the previous one (children follow)', () => {
    const body = '- First\n  - a: 1\n\n- Second\n  - b: 2';
    const r = apply(stateAt(body, 'l1Title', true, 1), demoteOutline);
    expect(count(r, 'outlineItem')).toBe(1);
    expect(count(r, 'l2Item')).toBe(3); // a:1, Second, b:2
  });

  it('the first bullet cannot be demoted (stays level 1)', () => {
    const r = apply(stateAt('- First\n  - a: 1\n\n- Second', 'l1Title', true, 0), demoteOutline);
    expect(count(r, 'outlineItem')).toBe(2);
  });

  it('Shift-Tab promotes a level-2 line to L1, keeping the whole "name: desc"', () => {
    const r = apply(stateAt('- First\n  - a: 1\n  - b: 2', 'l2Item', true, 1), promoteOutline);
    expect(count(r, 'outlineItem')).toBe(2);
    expect(allTexts(r, 'l1Title')).toContain('b: 2');
  });

  it('Tab is consumed in free text (no focus loss)', () => {
    expect(demoteOutline(stateAt('Intro\n\n- A', 'paragraph', true))).toBe(true);
  });

  it('Backspace deletes a freshly-added empty sub-point', () => {
    const withEmpty = apply(stateAt('- A\n  - keep: 1', 'l2Item', true), splitOutline);
    expect(count(withEmpty, 'l2Item')).toBe(2);
    const r = apply(withEmpty, backspaceOutline);
    expect(count(r, 'l2Item')).toBe(1);
  });

  it('Alt-Down moves an L1 bullet below its sibling', () => {
    const body = '- A\n  - a: 1\n\n- B\n  - b: 2';
    const r = apply(stateAt(body, 'l1Title', true, 0), siblingMove(1));
    expect(firstText(r, 'l1Title')).toBe('B');
  });

  it('Alt-Up on the first bullet is a no-op', () => {
    expect(siblingMove(-1)(stateAt('- A\n\n- B', 'l1Title', true, 0))).toBe(false);
  });
});
