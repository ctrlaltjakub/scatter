/**
 * ProseMirror commands for editing the strict bullet outline. Level-2 items are
 * single editable lines ("name: description"); promote/demote just move a line's
 * text between the L1-title and L2 levels, so a promoted bullet keeps its whole
 * "name: desc" as a title and demoting it restores the original look.
 *
 *   Enter   — new sibling bullet (L1 in a title, L2 in an l2 line)
 *   Tab     — DEMOTE an L1 into the previous one (its children follow). First stays L1.
 *   ShiftTab— PROMOTE an L2 to a new L1 in place (following siblings become its children).
 *   Backspace at the empty start of a bullet → delete it.
 *   Alt-↑/↓ — move the current bullet among its siblings.
 */
import { TextSelection, type Command, type EditorState } from '@tiptap/pm/state';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';

function depthOf(state: EditorState, name: string): number | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === name) return d;
  }
  return null;
}

/** Enter — split into a new sibling bullet. */
export const splitOutline: Command = (state, dispatch) => {
  if (!state.selection.empty) return false;
  const { $from } = state.selection;
  const parent = $from.parent.type.name;
  const schema = state.schema;

  if (parent === 'l1Title') {
    const oiDepth = depthOf(state, 'outlineItem');
    if (oiDepth === null) return false;
    const after = $from.after(oiDepth);
    const oi = schema.nodes.outlineItem!.createAndFill();
    if (!oi) return false;
    if (dispatch) {
      const tr = state.tr.insert(after, oi);
      dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(after + 2))).scrollIntoView());
    }
    return true;
  }

  if (parent === 'l2Item') {
    const liDepth = depthOf(state, 'l2Item');
    if (liDepth === null) return false;
    const after = $from.after(liDepth);
    const li = schema.nodes.l2Item!.createAndFill();
    if (!li) return false;
    if (dispatch) {
      const tr = state.tr.insert(after, li);
      dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1))).scrollIntoView());
    }
    return true;
  }

  return false;
};

/** Backspace at the empty start of a bullet → delete that (empty) bullet. */
export const backspaceOutline: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const parent = $from.parent.type.name;

  if (parent === 'l2Item') {
    const liDepth = depthOf(state, 'l2Item')!;
    if ($from.node(liDepth).textContent.trim() !== '') return false;
    const start = $from.before(liDepth);
    const end = $from.after(liDepth);
    if (dispatch) {
      const tr = state.tr.delete(start, end);
      dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, start - 1)), -1)).scrollIntoView());
    }
    return true;
  }

  if (parent === 'l1Title') {
    const oiDepth = depthOf(state, 'outlineItem')!;
    const section = $from.node(oiDepth - 1);
    if ($from.node(oiDepth).textContent.trim() !== '' || section.childCount <= 1) return false;
    const start = $from.before(oiDepth);
    const end = $from.after(oiDepth);
    if (dispatch) {
      const tr = state.tr.delete(start, end);
      dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, start - 1)), -1)).scrollIntoView());
    }
    return true;
  }

  return false;
};

/**
 * Tab — DEMOTE a level-1 bullet to level-2 under the previous L1 (its own children
 * follow). The FIRST bullet can't demote. Always consumes Tab (no focus loss).
 */
export const demoteOutline: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const oiDepth = depthOf(state, 'outlineItem');
  if ($from.parent.type.name !== 'l1Title' || oiDepth === null) return true;
  const sectionDepth = oiDepth - 1;
  const section = $from.node(sectionDepth);
  const index = $from.index(sectionDepth);
  if (index === 0) return true; // the first bullet must stay level 1
  if (!dispatch) return true;

  const schema = state.schema;
  const current = $from.node(oiDepth);
  const prev = section.child(index - 1);
  const currentStart = $from.posAtIndex(index, sectionDepth);
  const currentEnd = currentStart + current.nodeSize;
  const prevStart = $from.posAtIndex(index - 1, sectionDepth);
  const prevL2List = prev.child(1);
  const prevL2ListStart = prevStart + 1 + prev.child(0).nodeSize;
  const prevL2ListEnd = prevL2ListStart + prevL2List.nodeSize;

  // The L1 title becomes a single l2 line; its own children follow.
  const titleItem = schema.nodes.l2Item!.create(null, current.child(0).content);
  const newPrevL2List = prevL2List.type.create(
    prevL2List.attrs,
    prevL2List.content.append(Fragment.from(titleItem)).append(current.child(1).content),
  );
  const existingSize = prevL2List.content.size;

  const tr = state.tr;
  tr.delete(currentStart, currentEnd);
  tr.replaceWith(prevL2ListStart, prevL2ListEnd, newPrevL2List);
  const into = prevL2ListStart + 1 + existingSize + 1;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(into, tr.doc.content.size))));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Shift-Tab — PROMOTE a level-2 line to a new level-1 bullet IN PLACE: it stays
 * right after its parent, the whole "name: desc" line becomes the new title, and
 * the following siblings become its children. Always consumes Shift-Tab.
 */
export const promoteOutline: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const liDepth = depthOf(state, 'l2Item');
  const listDepth = depthOf(state, 'l2List');
  const oiDepth = depthOf(state, 'outlineItem');
  if (liDepth === null || listDepth === null || oiDepth === null) return true;
  if (!dispatch) return true;

  const schema = state.schema;
  const li = $from.node(liDepth);
  const list = $from.node(listDepth);
  const parent = $from.node(oiDepth);
  const liIndex = $from.index(listDepth);

  const preceding: PMNode[] = [];
  const following: PMNode[] = [];
  list.forEach((child, _off, i) => {
    if (i < liIndex) preceding.push(child);
    else if (i > liIndex) following.push(child);
  });

  const newParent = schema.nodes.outlineItem!.create(
    null,
    Fragment.fromArray([parent.child(0), schema.nodes.l2List!.create(null, Fragment.fromArray(preceding))]),
  );
  const newL1 = schema.nodes.outlineItem!.create(
    null,
    Fragment.fromArray([
      schema.nodes.l1Title!.create(null, li.content), // whole line → title
      schema.nodes.l2List!.create(null, Fragment.fromArray(following)),
    ]),
  );

  const oiStart = $from.before(oiDepth);
  const oiEnd = $from.after(oiDepth);
  const tr = state.tr.replaceWith(oiStart, oiEnd, Fragment.fromArray([newParent, newL1]));
  const titlePos = oiStart + newParent.nodeSize + 2;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(titlePos, tr.doc.content.size))));
  dispatch(tr.scrollIntoView());
  return true;
};

/** Move the current bullet (deepest of l2Item / outlineItem) up or down. */
export function siblingMove(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const depth = depthOf(state, 'l2Item') ?? depthOf(state, 'outlineItem');
    if (depth === null) return false;
    const parent = $from.node(depth - 1);
    const index = $from.index(depth - 1);
    const target = index + dir;
    if (target < 0 || target >= parent.childCount) return false;

    const node = $from.node(depth);
    const start = $from.before(depth);
    const end = start + node.nodeSize;
    if (dispatch) {
      const offset = $from.pos - start;
      const insertAt =
        dir === -1 ? start - parent.child(index - 1).nodeSize : start + parent.child(index + 1).nodeSize;
      const tr = state.tr.delete(start, end).insert(insertAt, node);
      dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + offset))).scrollIntoView());
    }
    return true;
  };
}
