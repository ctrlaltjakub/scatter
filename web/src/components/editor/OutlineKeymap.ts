import { Extension } from '@tiptap/core';
import type { Command } from '@tiptap/pm/state';
import { splitOutline, demoteOutline, promoteOutline, backspaceOutline, siblingMove } from './outlineCommands';

/**
 * Binds the outline editing commands. High priority so it intercepts Enter /
 * Tab / Backspace before the base keymap; each command returns false when it
 * doesn't apply (e.g. in free text), letting the default behaviour run.
 */
export const OutlineKeymap = Extension.create({
  name: 'outlineKeymap',
  priority: 1000,
  addKeyboardShortcuts() {
    const run = (cmd: Command) => () =>
      this.editor.commands.command(({ state, dispatch }) => cmd(state, dispatch));
    return {
      Enter: run(splitOutline),
      Tab: run(demoteOutline),
      'Shift-Tab': run(promoteOutline),
      Backspace: run(backspaceOutline),
      'Alt-ArrowUp': run(siblingMove(-1)),
      'Alt-ArrowDown': run(siblingMove(1)),
    };
  },
});
