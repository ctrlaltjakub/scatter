import { Extension, getMarkRange } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { expandToWordBoundaries } from './wordSnap';

/** Grab margins (px) around an active term's edge grip: generous on the OUTER
 *  side (where you reach for the grip) and smaller on the INNER side so the
 *  term's interior stays clickable for placing the caret. */
const EDGE_OUTER = 20;
const EDGE_INNER = 12;

export const termResizeKey = new PluginKey<{ active: { from: number; to: number } | null }>('termResize');
const key = termResizeKey;

interface Drag {
  from: number; // current marked range, kept in sync while dragging
  to: number;
  fixed: number; // the edge that stays put
}

/**
 * Click a term highlight to ACTIVATE it (edge grips appear via a decoration);
 * drag a grip to resize the marking, snapping to whole words. Clicking the
 * middle of a term still places the caret (the word stays editable); clicking
 * outside any term deactivates. Working-copy edit only.
 */
export const TermResize = Extension.create({
  name: 'termResize',
  addProseMirrorPlugins() {
    let drag: Drag | null = null;

    const onMove = (view: EditorView, clientX: number, clientY: number) => {
      if (!drag) return;
      const termType = view.state.schema.marks.term;
      if (!termType) return;
      const at = view.posAtCoords({ left: clientX, top: clientY });
      if (!at) return;
      const word = expandToWordBoundaries(view.state, at.pos, at.pos);
      const from = drag.fixed <= word.from ? drag.fixed : word.from;
      const to = drag.fixed <= word.from ? word.to : drag.fixed;
      if (from >= to) return;
      const $fixed = view.state.doc.resolve(drag.fixed);
      if (!view.state.doc.resolve(from).sameParent($fixed) || !view.state.doc.resolve(to).sameParent($fixed)) return;
      if (from === drag.from && to === drag.to) return;
      const tr = view.state.tr
        .removeMark(drag.from, drag.to, termType)
        .addMark(from, to, termType.create())
        .setMeta(key, { from, to });
      view.dispatch(tr);
      drag.from = from;
      drag.to = to;
    };

    return [
      new Plugin({
        key,
        state: {
          init: () => ({ active: null as { from: number; to: number } | null }),
          apply(tr, prev) {
            const meta = tr.getMeta(key);
            if (meta !== undefined) return { active: meta };
            if (!prev.active) return prev;
            // Typing deactivates; so does moving the caret out of the active term.
            if (tr.docChanged) return { active: null };
            if (tr.selectionSet) {
              const { from, to } = tr.selection;
              const a = prev.active;
              return from >= a.from && to <= a.to ? prev : { active: null };
            }
            return prev;
          },
        },
        props: {
          decorations(state) {
            const s = key.getState(state);
            if (!s?.active || s.active.from >= s.active.to) return null;
            const { from, to } = s.active;
            return DecorationSet.create(state.doc, [
              // Flat, continuous highlight (rounding lives on the end-cap grips).
              Decoration.inline(from, to, { class: 'is-term-active' }),
              // Grips ride the FIRST and LAST character only — one each. A term that
              // crosses a bold word fragments into several <span>s; anchoring the
              // grips to the two end characters keeps exactly two parentheses at the
              // true ends instead of one per fragment.
              Decoration.inline(from, from + 1, { class: 'is-term-cap-l' }),
              Decoration.inline(to - 1, to, { class: 'is-term-cap-r' }),
            ]);
          },
          handleDOMEvents: {
            mousedown: (view, event) => {
              const termType = view.state.schema.marks.term;
              if (!termType) return false;
              const s = key.getState(view.state);

              // 1. Grab a grip of the already-active term → start resizing.
              if (s?.active) {
                const leftX = view.coordsAtPos(s.active.from).left;
                const rightX = view.coordsAtPos(s.active.to).left;
                const x = event.clientX;
                let edge: 'left' | 'right' | null = null;
                if (x >= leftX - EDGE_OUTER && x <= leftX + EDGE_INNER) edge = 'left';
                else if (x >= rightX - EDGE_INNER && x <= rightX + EDGE_OUTER) edge = 'right';
                if (edge) {
                  event.preventDefault();
                  drag = {
                    from: s.active.from,
                    to: s.active.to,
                    fixed: edge === 'left' ? s.active.to : s.active.from,
                  };
                  const move = (e: MouseEvent) => onMove(view, e.clientX, e.clientY);
                  const up = () => {
                    drag = null;
                    window.removeEventListener('mousemove', move);
                    window.removeEventListener('mouseup', up);
                  };
                  window.addEventListener('mousemove', move);
                  window.addEventListener('mouseup', up);
                  return true;
                }
              }

              // 2. Click inside a term → activate it (and place the caret).
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              const range = at ? getMarkRange(view.state.doc.resolve(at.pos), termType) : null;
              if (range) {
                if (!s?.active || s.active.from !== range.from || s.active.to !== range.to) {
                  view.dispatch(view.state.tr.setMeta(key, { from: range.from, to: range.to }));
                }
                return false;
              }

              // 3. Click outside any term → deactivate.
              if (s?.active) view.dispatch(view.state.tr.setMeta(key, null));
              return false;
            },
          },
        },
      }),
    ];
  },
});
