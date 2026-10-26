import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimatedCollapse } from './AnimatedCollapse';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('animated settings disclosures', () => {
  it('lazy mounts, animates both ways, hides closing controls immediately, then unmounts', () => {
    const body = <button>Nested control</button>;
    const { container, rerender } = render(<AnimatedCollapse open={false}>{body}</AnimatedCollapse>);
    expect(container).toBeEmptyDOMElement();
    rerender(<AnimatedCollapse open>{body}</AnimatedCollapse>);
    expect(container.firstChild).toHaveAttribute('data-expanded', 'false');
    act(() => vi.advanceTimersByTime(32));
    expect(container.firstChild).toHaveAttribute('data-expanded', 'true');
    act(() => vi.advanceTimersByTime(180));
    expect(container.firstChild).toHaveAttribute('data-animating', 'false');
    rerender(<AnimatedCollapse open={false}>{body}</AnimatedCollapse>);
    expect(container.firstChild).toHaveAttribute('data-expanded', 'false');
    expect((container.firstChild as HTMLElement).inert).toBe(true);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container).not.toBeEmptyDOMElement();
    act(() => vi.advanceTimersByTime(180));
    expect(container).toBeEmptyDOMElement();
  });
  it('supports rapid reversal without a stale timer removing reopened content', () => {
    const { container, rerender } = render(<AnimatedCollapse open><input /></AnimatedCollapse>);
    rerender(<AnimatedCollapse open={false}><input /></AnimatedCollapse>);
    act(() => vi.advanceTimersByTime(60));
    rerender(<AnimatedCollapse open><input /></AnimatedCollapse>);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute('data-expanded', 'true');
    expect(container.firstChild).toHaveAttribute('data-animating', 'false');
  });
  it('changes immediately when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const { container, rerender } = render(<AnimatedCollapse open={false}>Content</AnimatedCollapse>);
    rerender(<AnimatedCollapse open>Content</AnimatedCollapse>);
    expect(container.firstChild).toHaveAttribute('data-expanded', 'true');
    expect(container.firstChild).toHaveAttribute('data-animating', 'false');
    rerender(<AnimatedCollapse open={false}>Content</AnimatedCollapse>);
    expect(container).toBeEmptyDOMElement();
  });
});
