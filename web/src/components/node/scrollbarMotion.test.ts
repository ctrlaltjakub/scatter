import { describe, expect, it, vi } from 'vitest';
import { advanceScrollbarClock, animateScrollbarRange, SCROLLBAR_MOTION_MS } from './scrollbarMotion';

describe('scrollbar frame clock', () => {
  it('keeps the existing duration at 60Hz and at higher refresh rates', () => {
    for (const hz of [60, 90, 120, 144]) {
      let elapsed = 0;
      const frames = Math.ceil(SCROLLBAR_MOTION_MS / (1000 / hz));
      for (let i = 0; i < frames; i++) elapsed = advanceScrollbarClock(elapsed, 1000 / hz);
      expect(elapsed).toBeCloseTo(SCROLLBAR_MOTION_MS);
    }
  });

  it('does not skip visible motion after a slow frame or a background-tab pause', () => {
    expect(advanceScrollbarClock(40, 100)).toBeCloseTo(40 + 1000 / 60);
    expect(advanceScrollbarClock(40, 10_000)).toBeCloseTo(40 + 1000 / 60);
    expect(advanceScrollbarClock(40, -5)).toBe(40);
    expect(advanceScrollbarClock(279, 16)).toBe(SCROLLBAR_MOTION_MS);
  });

  it('starts a new animation from the currently visible geometry after interruption', () => {
    const bar = document.createElement('div');
    bar.style.top = '0px'; bar.style.height = '40px';
    const animation = { pause: vi.fn(), cancel: vi.fn(), currentTime: 0 };
    bar.animate = vi.fn(() => animation as unknown as Animation);
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const cleanup = animateScrollbarRange(bar, { top: 200, height: 140 });
    expect(animation.pause).toHaveBeenCalledOnce();
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ top: '70px', height: '75px' } as CSSStyleDeclaration);
    cleanup();
    expect(bar.style.top).toBe('70px');
    expect(bar.style.height).toBe('75px');
    animateScrollbarRange(bar, { top: 20, height: 60 })();
    expect(bar.animate).toHaveBeenLastCalledWith([
      { top: '70px', height: '75px' }, { top: '20px', height: '60px' },
    ], { duration: 280, easing: 'ease', fill: 'both' });
    vi.restoreAllMocks();
  });
});
