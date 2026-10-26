import { createElement, type CSSProperties } from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WelcomeTabShape, welcomeTabShape } from './WelcomeTabShape';

afterEach(() => vi.unstubAllGlobals());

describe('continuous tab outline', () => {
  it('joins the frame at the same half-pixel centerline with one-pixel corners', () => {
    const shape = welcomeTabShape(200, 38, 14);
    expect(shape.viewBox).toBe('-13 0 226 38');
    expect(shape.outline).toBe('M-13 37.5A13.5 13.5 0 0 0 .5 24V14A13.5 13.5 0 0 1 14 .5H186A13.5 13.5 0 0 1 199.5 14V24A13.5 13.5 0 0 0 213 37.5');
    expect(shape.outline).not.toContain('Z');
    expect(shape.fill).toBe(`${shape.outline}V39H-13Z`);
  });
  it('preserves fractional widths during resizing instead of rounding to pixels', () => {
    const shape = welcomeTabShape(204.78125, 38, 14);
    expect(shape.viewBox).toBe('-13 0 230.78125 38');
    expect(shape.outline).toContain('H190.78125');
    expect(shape.outline).toContain('204.28125 14');
    expect(shape.outline).toContain('217.78125 37.5');
  });
  it('tracks layout width changes without using transformed screen dimensions and cleans up', () => {
    let callback: ResizeObserverCallback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(fn: ResizeObserverCallback) { callback = fn; }
      observe = observe;
      disconnect = disconnect;
    });
    const { container, unmount } = render(createElement('button', { style: {
      width: 200, height: 38, boxSizing: 'border-box', transform: 'scale(5)', '--welcome-tab-radius': '14px',
    } as CSSProperties }, createElement(WelcomeTabShape)));
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('-13 0 226 38');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(observe).toHaveBeenCalledWith(container.querySelector('button'), { box: 'border-box' });
    callback!([{ borderBoxSize: [{ inlineSize: 220.75, blockSize: 38 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    expect(svg.getAttribute('viewBox')).toBe('-13 0 246.75 38');
    expect(svg.querySelector('.welcome-start-tab-shape-stroke')?.getAttribute('d')).toBe(welcomeTabShape(220.75, 38, 14).outline);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
