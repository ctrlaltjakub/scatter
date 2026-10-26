import type { KeyBinding } from '@/store/types';

/**
 * Single source of truth for the app's keyboard shortcuts.
 *
 * Both the global keydown handler (app/page.tsx) and the two display
 * catalogs (SidebarShortcuts, the Settings ShortcutsTab) consume this list,
 * so they can never drift apart. Each action can have up to TWO bindings (a
 * primary + an alternative), overridable by the user — overrides live in
 * settings.keybindings, keyed by action id; absent ids fall back to
 * `defaultBindings`.
 *
 * Scope: only the core single-combo actions are rebindable. Pan (a held-key
 * gesture set) and the chip Ctrl/⌘+click (a mouse interaction) are shown for
 * reference but fixed, and Esc/deselect stays fixed because its handler also
 * blurs inputs / defers to open dialogs.
 */

/** Max bindings (primary + alternative) per action. */
export const MAX_BINDINGS = 2;

/** Label for the cross-platform modifier ("mod"). We show BOTH forms —
 *  "Ctrl/⌘" — so the binding reads correctly on Windows/Linux and macOS
 *  without per-platform detection. SidebarShortcuts' renderKeyChars styles
 *  the ⌘ glyph within the string. */
export const MOD_LABEL = 'Ctrl/⌘';

/** How the action's availability is decided in the sidebar shortcut list. */
export type Availability =
  | 'always'
  | 'canUndo'
  | 'canRedo'
  | 'hasSelection'
  | 'textSelection'
  | 'chipHover'
  | 'scrollHover'
  | 'nodeHover'
  | 'hasNodes'
  | 'multipleModels';

export interface KeyActionDef {
  id: string;
  /** Human label (shown in the Settings rebinding UI). */
  label: string;
  /** Short lowercase hint (shown in the sidebar shortcut list). */
  hint: string;
  /** Default binding(s) — 1 or 2. */
  defaultBindings: KeyBinding[];
  /** User can rebind this action. */
  rebindable: boolean;
  /** Shift is consumed by the action (e.g. direction), so the matcher ignores
   *  it. Used by cycleModel (Shift = previous). */
  shiftForDirection?: boolean;
  /** Handler runs BEFORE the "ignore while typing in a field" guard. */
  worksInEditable?: boolean;
  availability?: Availability;
  /** Fixed display string for non-rebindable / multi-key rows (pan, chip).
   *  `{mod}` is replaced with the platform modifier label. */
  display?: string;
}

export const KEY_ACTIONS: KeyActionDef[] = [
  { id: 'search', label: 'Focus search', hint: 'search', defaultBindings: [{ key: 'k', meta: true }], rebindable: true, worksInEditable: true, availability: 'always' },
  { id: 'cycleModel', label: 'Switch model', hint: 'model (⇧ prev)', defaultBindings: [{ key: 'm', meta: true }], rebindable: true, shiftForDirection: true, availability: 'multipleModels' },
  { id: 'toggleSidebar', label: 'Toggle sidebar', hint: 'toggle sidebar', defaultBindings: [{ key: 'b', meta: true }], rebindable: true, worksInEditable: true, availability: 'always' },
  { id: 'fullscreen', label: 'Fullscreen', hint: 'fullscreen', defaultBindings: [{ key: 'f' }], rebindable: true, availability: 'always' },
  { id: 'undo', label: 'Undo', hint: 'undo', defaultBindings: [{ key: 'z', meta: true }], rebindable: true, availability: 'canUndo' },
  { id: 'redo', label: 'Redo', hint: 'redo', defaultBindings: [{ key: 'y', meta: true }, { key: 'z', meta: true, shift: true }], rebindable: true, availability: 'canRedo' },
  // Fixed rows — shown for reference, not rebindable.
  { id: 'deselect', label: 'Deselect', hint: 'deselect', defaultBindings: [{ key: 'escape' }], rebindable: false, availability: 'hasSelection' },
  { id: 'pan', label: 'Pan camera', hint: 'pan camera', defaultBindings: [{ key: 'w' }], rebindable: false, display: 'WASD', availability: 'always' },
  { id: 'selectNodesBox', label: 'Select nodes in a rectangle', hint: 'select nodes', defaultBindings: [{ key: 'drag', shift: true }], rebindable: false, display: 'Shift+drag', availability: 'hasNodes' },
  { id: 'selectNodesAddBox', label: 'Add a rectangle to node selection', hint: 'add to selection', defaultBindings: [], rebindable: false, display: '{mod}+Shift+drag', availability: 'hasSelection' },
  { id: 'selectNodesClick', label: 'Add or remove a node from selection', hint: 'toggle selection', defaultBindings: [{ key: 'click', meta: true }], rebindable: false, display: '{mod}+click', availability: 'nodeHover' },
  // Reading ruler (dyslexia/ADHD reading aid): with a text node selected the
  // arrows step a line highlight; ←/→ enter word-by-word mode. One combined
  // hint; shown only for text nodes (media has nothing to read). Fixed
  // gesture set like pan — the handler lives in lib/readingController.
  { id: 'readingRuler', label: 'Reading ruler', hint: 'reading ruler', defaultBindings: [{ key: 'arrowdown' }], rebindable: false, display: '← ↑ ↓ →', availability: 'textSelection' },
  { id: 'zoom', label: 'Zoom camera', hint: 'zoom camera', defaultBindings: [{ key: 'q' }, { key: 'e' }], rebindable: false, display: 'Q / E', availability: 'always' },
  { id: 'chipCollapsed', label: 'New node collapsed', hint: 'explore collapsed', defaultBindings: [{ key: 'click', meta: true }], rebindable: false, display: '{mod}+click', availability: 'chipHover' },
  { id: 'forceScroll', label: 'Force zoom (zoom even over the focused node)', hint: 'force zoom', defaultBindings: [{ key: 'wheel', meta: true }], rebindable: false, display: '{mod}+scroll', availability: 'scrollHover' },
];

/** Context-owned controls are documented here, but never dispatched globally. */
export const CONTEXT_SHORTCUTS = [
  { id: 'image-part', group: 'Image regions', keys: 'Drag', label: 'Select part of a focused image' },
  { id: 'image-add', group: 'Image regions', keys: 'Ctrl/⌘+drag', label: 'Add image parts' },
  { id: 'image-clear', group: 'Image regions', keys: 'Esc', label: 'Clear image selection' },
  { id: 'ruler-exit', group: 'Reading ruler', keys: 'Esc', label: 'Exit reading ruler' },
  { id: 'ruler-open', group: 'Reading ruler', keys: '↵', label: 'Explore the highlighted term or show its node' },
  { id: 'ruler-collapsed', group: 'Reading ruler', keys: 'Ctrl/⌘+↵', label: 'Explore an unlinked term as a collapsed node' },
  { id: 'text-clear', group: 'Text selection', keys: 'Esc', label: 'Clear text selection' },
  { id: 'chat-stop', group: 'Chat', keys: 'Esc', label: 'Stop generating the focused chat answer' },
  { id: 'chat-send', group: 'Chat and follow-ups', keys: '↵ or Ctrl/⌘+↵', label: 'Send — follows the Enter-key setting in Canvas and nodes' },
  { id: 'chat-newline', group: 'Chat and follow-ups', keys: 'Shift+↵', label: 'Insert a new line' },
  { id: 'topic-send', group: 'Topic picker', keys: '↵', label: 'Start from the topic or chat prompt' },
  { id: 'topic-newline', group: 'Topic picker', keys: 'Shift+↵', label: 'Insert a new line in the prompt' },
  { id: 'topic-expanded', group: 'Expanded topic editor', keys: 'Ctrl/⌘+↵', label: 'Start from the expanded prompt' },
  { id: 'topic-tabs', group: 'Topic picker tabs', keys: '← / → / Home / End', label: 'Switch between topic, chat, and image while a tab is focused' },
  { id: 'image-url', group: 'Image link field', keys: '↵', label: 'Load the image from its link' },
  { id: 'editor-bold', group: 'Text editor', keys: 'Ctrl/⌘+B', label: 'Toggle bold text' },
  { id: 'editor-promote', group: 'Text editor', keys: 'Shift+Tab', label: 'Promote a bullet to level 1' },
  { id: 'editor-demote', group: 'Text editor', keys: 'Tab', label: 'Demote a bullet to a sub-bullet' },
  { id: 'editor-close', group: 'Editors', keys: 'Esc', label: 'Close and save (first clears any active image selection)' },
  { id: 'image-pan', group: 'Image editor', keys: 'Space+drag / WASD', label: 'Pan the image' },
  { id: 'image-zoom', group: 'Image editor', keys: 'Q / E', label: 'Zoom out / in' },
  { id: 'image-force-select', group: 'Image editor', keys: 'Shift+drag', label: 'Select image parts over annotations with the pointer tool' },
  { id: 'image-elements', group: 'Image editor', keys: 'Shift+click', label: 'Add or remove an annotation from selection' },
  { id: 'image-delete', group: 'Image editor', keys: 'Del / Backspace', label: 'Delete selected annotations' },
  { id: 'image-text', group: 'Image annotation text', keys: '↵ / Esc', label: 'Finish editing the annotation; Shift+Enter inserts a new line' },
  { id: 'editor-undo', group: 'Editors', keys: 'Ctrl/⌘+Z', label: 'Undo an editor change' },
  { id: 'editor-redo', group: 'Editors', keys: 'Ctrl/⌘+Shift+Z / Ctrl/⌘+Y', label: 'Redo an editor change' },
] as const;

export function actionDef(id: string): KeyActionDef | undefined {
  return KEY_ACTIONS.find((a) => a.id === id);
}

/** Resolve an action's effective bindings (user override, else defaults). */
export function resolveBindings(id: string, overrides?: Record<string, KeyBinding[]> | null): KeyBinding[] {
  const ov = overrides?.[id];
  if (ov && ov.length > 0) return ov;
  return actionDef(id)?.defaultBindings ?? [];
}

/** Does a keyboard event match a binding? `ignoreShift` lets shift-for-
 *  direction actions (cycleModel) match with or without Shift held. */
export function matchBinding(e: KeyboardEvent, b: KeyBinding, opts?: { ignoreShift?: boolean }): boolean {
  if (!b.key) return false;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key.toLowerCase() !== b.key) return false;
  if (!!b.meta !== mod) return false;
  if (!opts?.ignoreShift && !!b.shift !== e.shiftKey) return false;
  if (!!b.alt !== e.altKey) return false;
  return true;
}

/** Match an action by id against an event (any of its bindings), honouring
 *  its overrides and its shiftForDirection flag. */
export function matchAction(e: KeyboardEvent, id: string, overrides?: Record<string, KeyBinding[]> | null): boolean {
  const def = actionDef(id);
  if (!def) return false;
  const opts = { ignoreShift: def.shiftForDirection };
  return resolveBindings(id, overrides).some((b) => matchBinding(e, b, opts));
}

export function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
  return a.key === b.key && !!a.meta === !!b.meta && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}

const KEY_GLYPHS: Record<string, string> = {
  escape: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  ' ': 'Space', enter: '↵', backspace: '⌫', tab: 'Tab', delete: 'Del',
};

function keyGlyph(key: string): string {
  if (KEY_GLYPHS[key]) return KEY_GLYPHS[key]!;
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/** Render a binding as a display string (e.g. "Ctrl+K" / "⌘K", "Ctrl+⇧Z", "F").
 *  The modifier follows the platform (Ctrl on Linux/Windows, ⌘ on macOS). */
export function bindingToGlyph(b: KeyBinding): string {
  const mods: string[] = [];
  if (b.meta) mods.push(MOD_LABEL);
  if (b.alt) mods.push('Alt');
  // Shift attaches to the key (⇧Z) rather than being a separate +token.
  const keyPart = (b.shift ? '⇧' : '') + keyGlyph(b.key);
  return [...mods, keyPart].join('+');
}

/** Display string for an action's PRIMARY binding (or its fixed `display`).
 *  Used by the compact sidebar list. */
export function actionGlyph(id: string, overrides?: Record<string, KeyBinding[]> | null): string {
  const def = actionDef(id);
  if (def?.display) return def.display.replace('{mod}', MOD_LABEL);
  const first = resolveBindings(id, overrides)[0];
  return first ? bindingToGlyph(first) : '';
}

// Plain (no-modifier) keys claimed by the fixed pan / reading-ruler gestures.
const PAN_KEYS = new Set(['w', 'a', 's', 'd']);
const READ_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

/**
 * If `b` collides with another app binding, return that action's label (so
 * the rebinding UI can warn). Checks every binding of the rebindable actions
 * + the fixed deselect (Esc) and the pan keys. `selfId` is excluded.
 */
export function findAppConflict(b: KeyBinding, selfId: string, overrides?: Record<string, KeyBinding[]> | null): string | null {
  for (const a of KEY_ACTIONS) {
    if (a.id === selfId) continue;
    if (a.id === 'pan' || a.id === 'readingRuler' || a.id === 'chipCollapsed') continue; // handled below / mouse-only
    if (resolveBindings(a.id, overrides).some((x) => bindingsEqual(x, b))) return a.label;
  }
  if (!b.meta && !b.alt && PAN_KEYS.has(b.key)) return 'Pan camera';
  if (!b.meta && !b.alt && READ_KEYS.has(b.key)) return 'Reading ruler';
  return null;
}

/** Combos the browser typically reserves — warn but still allow (some users
 *  run the app as a standalone PWA where these reach the page). */
export const BROWSER_RESERVED: KeyBinding[] = [
  { key: 't', meta: true }, { key: 'w', meta: true }, { key: 'n', meta: true },
  { key: 'l', meta: true }, { key: 'r', meta: true }, { key: 'd', meta: true },
  { key: 'q', meta: true }, { key: 'p', meta: true }, { key: 's', meta: true },
  { key: '[', meta: true }, { key: ']', meta: true },
  { key: '=', meta: true }, { key: '-', meta: true }, { key: 'tab', meta: true },
  { key: 'f5' }, { key: 'f6' }, { key: 'f11' }, { key: 'f12' },
];

export function isBrowserReserved(b: KeyBinding): boolean {
  return BROWSER_RESERVED.some((r) => bindingsEqual(r, b));
}

const MODIFIER_KEYS = new Set(['control', 'meta', 'shift', 'alt', 'os', 'hyper', 'capslock', 'contextmenu']);

/** Build a binding from a captured keydown, or null for a bare modifier press. */
export function bindingFromEvent(e: KeyboardEvent): KeyBinding | null {
  const key = e.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;
  const b: KeyBinding = { key };
  if (e.ctrlKey || e.metaKey) b.meta = true;
  if (e.shiftKey) b.shift = true;
  if (e.altKey) b.alt = true;
  return b;
}
