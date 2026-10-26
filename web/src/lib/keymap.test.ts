import { describe, expect, test } from 'vitest';
import {
  resolveBindings, matchBinding, matchAction, bindingsEqual,
  bindingToGlyph, actionGlyph, findAppConflict, isBrowserReserved, bindingFromEvent,
} from './keymap';
import type { KeyBinding } from '@/store/types';

/** Minimal fake of the fields matchBinding/bindingFromEvent read. */
function ev(key: string, mods: { meta?: boolean; shift?: boolean; alt?: boolean } = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: !!mods.meta,
    metaKey: false,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  } as unknown as KeyboardEvent;
}

describe('resolveBindings', () => {
  test('returns the defaults when no override', () => {
    expect(resolveBindings('search')).toEqual([{ key: 'k', meta: true }]);
    // Redo presents Ctrl/⌘+Y in the shortcut list, while retaining
    // Ctrl/⌘+Shift+Z as an alternative.
    expect(resolveBindings('redo')).toHaveLength(2);
    expect(actionGlyph('redo')).toBe('Ctrl/⌘+Y');
  });
  test('honours an override array', () => {
    expect(resolveBindings('search', { search: [{ key: 'j', meta: true }] })).toEqual([{ key: 'j', meta: true }]);
  });
});

describe('matchBinding', () => {
  test('matches exact modifiers', () => {
    expect(matchBinding(ev('k', { meta: true }), { key: 'k', meta: true })).toBe(true);
    expect(matchBinding(ev('k'), { key: 'k', meta: true })).toBe(false); // missing mod
  });
  test('distinguishes undo (no shift) from redo (shift)', () => {
    const undo: KeyBinding = { key: 'z', meta: true };
    const redo: KeyBinding = { key: 'z', meta: true, shift: true };
    expect(matchBinding(ev('z', { meta: true }), undo)).toBe(true);
    expect(matchBinding(ev('z', { meta: true }), redo)).toBe(false);
    expect(matchBinding(ev('z', { meta: true, shift: true }), redo)).toBe(true);
  });
});

describe('matchAction', () => {
  test('matches any of an action’s bindings (redo: ⌘⇧Z or ⌘Y)', () => {
    expect(matchAction(ev('z', { meta: true, shift: true }), 'redo')).toBe(true);
    expect(matchAction(ev('y', { meta: true }), 'redo')).toBe(true);
    expect(matchAction(ev('z', { meta: true }), 'redo')).toBe(false); // that's undo
  });
  test('ignoreShift lets a shift-for-direction action match either way', () => {
    expect(matchAction(ev('m', { meta: true }), 'cycleModel')).toBe(true);
    expect(matchAction(ev('m', { meta: true, shift: true }), 'cycleModel')).toBe(true);
  });
  test('honours an override', () => {
    const ov = { search: [{ key: 'j', meta: true }] };
    expect(matchAction(ev('j', { meta: true }), 'search', ov)).toBe(true);
    expect(matchAction(ev('k', { meta: true }), 'search', ov)).toBe(false);
  });
});

describe('findAppConflict', () => {
  test('detects a clash with another rebindable action', () => {
    expect(findAppConflict({ key: 'm', meta: true }, 'search')).toBe('Switch model');
  });
  test('detects a clash with a pan key', () => {
    expect(findAppConflict({ key: 'w' }, 'fullscreen')).toBe('Pan camera');
  });
  test('detects a clash with redo’s alternate binding (⌘Y)', () => {
    expect(findAppConflict({ key: 'y', meta: true }, 'search')).toBe('Redo');
  });
  test('no clash for a free combo', () => {
    expect(findAppConflict({ key: 'j', meta: true }, 'search')).toBeNull();
  });
  test('does not clash with itself', () => {
    expect(findAppConflict({ key: 'k', meta: true }, 'search')).toBeNull();
  });
});

describe('glyphs (both modifiers shown)', () => {
  test('bindingToGlyph formats modifiers + key', () => {
    expect(bindingToGlyph({ key: 'k', meta: true })).toBe('Ctrl/⌘+K');
    expect(bindingToGlyph({ key: 'z', meta: true, shift: true })).toBe('Ctrl/⌘+⇧Z');
    expect(bindingToGlyph({ key: 'f' })).toBe('F');
  });
  test('actionGlyph uses the fixed display for pan (WASD — arrows drive the reading ruler)', () => {
    expect(actionGlyph('pan')).toBe('WASD');
  });
  test('actionGlyph shows the reading-ruler glyph', () => {
    expect(actionGlyph('readingRuler')).toBe('← ↑ ↓ →');
  });
  test('actionGlyph substitutes the modifier in the chip display', () => {
    expect(actionGlyph('chipCollapsed')).toBe('Ctrl/⌘+click');
  });
  test('lists both node multi-selection gestures', () => {
    expect(actionGlyph('selectNodesBox')).toBe('Shift+drag');
    expect(actionGlyph('selectNodesClick')).toBe('Ctrl/⌘+click');
  });
});

describe('isBrowserReserved', () => {
  test('flags ⌘T', () => {
    expect(isBrowserReserved({ key: 't', meta: true })).toBe(true);
  });
  test('allows ⌘K', () => {
    expect(isBrowserReserved({ key: 'k', meta: true })).toBe(false);
  });
});

describe('bindingFromEvent', () => {
  test('builds a binding from a combo', () => {
    expect(bindingFromEvent(ev('j', { meta: true }))).toEqual({ key: 'j', meta: true });
  });
  test('returns null for a bare modifier', () => {
    expect(bindingFromEvent(ev('Shift'))).toBeNull();
  });
});

describe('bindingsEqual', () => {
  test('treats undefined and false modifiers as equal', () => {
    expect(bindingsEqual({ key: 'f' }, { key: 'f', meta: false, shift: false })).toBe(true);
    expect(bindingsEqual({ key: 'f' }, { key: 'f', meta: true })).toBe(false);
  });
});
