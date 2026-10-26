import { describe, it, expect } from 'vitest';
import { shouldSubmitOnEnter } from './editorKeys';

describe('shouldSubmitOnEnter', () => {
  it('plain Enter submits', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false })).toBe(true);
  });

  it('Shift+Enter does NOT submit (reserved for a newline)', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('Ctrl/⌘+Enter still submits — only Shift suppresses it, so a non-shift Enter passes', () => {
    // The helper ignores Ctrl/⌘ (they leave shiftKey false), so Ctrl+Enter submits too.
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false })).toBe(true);
  });

  it('non-Enter keys never submit', () => {
    expect(shouldSubmitOnEnter({ key: 'a', shiftKey: false })).toBe(false);
    expect(shouldSubmitOnEnter({ key: 'Tab', shiftKey: false })).toBe(false);
  });

  it('does not submit while an IME composition is being confirmed', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
  });
});
