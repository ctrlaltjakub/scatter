import { describe, expect, it } from 'vitest';
import { positionSelectionToolbar } from './positionSelectionToolbar';

describe('selection toolbar placement', () => {
  it.each([1, 0.5, 2])('keeps the full width inside both screen edges at zoom %s', zoom => {
    const bar = document.createElement('div');
    Object.defineProperties(bar, { offsetWidth: { value: 350 }, offsetHeight: { value: 28 } });
    const margin = 8;
    for (const left of [0, window.innerWidth - 10]) {
      positionSelectionToolbar(bar, { left, width: 10, top: 200 }, zoom);
      const center = Number.parseFloat(bar.style.left);
      expect(center - 175 * zoom).toBeGreaterThanOrEqual(margin);
      expect(center + 175 * zoom).toBeLessThanOrEqual(window.innerWidth - margin);
      expect(bar.style.maxWidth).toBe(`${(window.innerWidth - 16) / zoom}px`);
    }
  });
  it('allows wrapped toolbars to remain visible near the top', () => {
    const bar = document.createElement('div');
    Object.defineProperties(bar, { offsetWidth: { value: 300 }, offsetHeight: { value: 64 } });
    positionSelectionToolbar(bar, { left: 100, width: 80, top: 4 });
    expect(bar.style.top).toBe('72px');
  });
});
