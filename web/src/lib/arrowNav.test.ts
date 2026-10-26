import { describe, it, expect } from 'vitest';
import { resolveArrowLabelEnd } from './arrowNav';

describe('resolveArrowLabelEnd', () => {
  it('uses the child unless the child is fully visible and the parent is off-screen', () => {
    expect(resolveArrowLabelEnd({ childFullyVisible: false, parentPartiallyVisible: false })).toBe('child');
    expect(resolveArrowLabelEnd({ childFullyVisible: false, parentPartiallyVisible: true })).toBe('child');
    expect(resolveArrowLabelEnd({ childFullyVisible: true, parentPartiallyVisible: true })).toBe('child');
  });

  it('uses the parent when the child is fully visible and the parent is off-screen', () => {
    expect(resolveArrowLabelEnd({ childFullyVisible: true, parentPartiallyVisible: false })).toBe('parent');
  });
});
