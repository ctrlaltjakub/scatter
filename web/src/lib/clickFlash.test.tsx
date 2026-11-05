import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useClickFlash } from './clickFlash';
import { installClickFlash } from './clickFlashRuntime';

function Harness() {
  useClickFlash();
  return (
    <button type="button" aria-disabled="true" data-testid="disabled-control">
      <span data-testid="disabled-child">Unavailable action</span>
    </button>
  );
}

describe('disabled click cursor feedback', () => {
  const flashing = () => document.querySelectorAll('.sc-pressing, .sc-disabled-pressing').length;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('marks only the pressed element, so a press never restyles the whole document', () => {
    render(<Harness />);
    const child = screen.getByTestId('disabled-child');
    fireEvent.pointerDown(child);
    expect(child).toHaveClass('sc-disabled-pressing');
    expect(document.documentElement).not.toHaveClass('sc-pressing', 'sc-disabled-pressing');
    expect(document.body).not.toHaveClass('sc-pressing', 'sc-disabled-pressing');
  });

  it('briefly shows the disabled cursor when an aria-disabled control is pressed', () => {
    render(<Harness />);

    const child = screen.getByTestId('disabled-child');
    fireEvent.pointerDown(child);

    expect(child).toHaveClass('sc-disabled-pressing');
    expect(child).not.toHaveClass('sc-pressing');

    act(() => { vi.advanceTimersByTime(150); });
    expect(flashing()).toBe(0);
  });

  it.each(['pointer', 'default', 'text', 'grab'])('recognizes the %s fallback after an image-set cursor', fallback => {
    render(<button type="button" data-testid="cursor-control">Control</button>);
    render(<Harness />);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      cursor: `image-set(url("data:image/png;base64,a") 1x, url("data:image/png;base64,b") 2x) 3 3, ${fallback}`,
    } as CSSStyleDeclaration);
    fireEvent.pointerDown(screen.getByTestId('cursor-control'));
    expect(screen.getByTestId('cursor-control').classList.contains('sc-pressing')).toBe(['pointer', 'default'].includes(fallback));
    act(() => { vi.advanceTimersByTime(150); });
    expect(flashing()).toBe(0);
  });

  it('works from its serialized sandbox source and clears feedback after a quick click', () => {
    const install = (0, eval)(`(${installClickFlash.toString()})`) as typeof installClickFlash;
    const dispose = install(document);
    render(<label><input type="checkbox" data-testid="checkbox" />Enabled</label>);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ cursor: 'pointer' } as CSSStyleDeclaration);
    fireEvent.pointerDown(screen.getByTestId('checkbox'));
    fireEvent.pointerUp(screen.getByTestId('checkbox'));
    expect(screen.getByTestId('checkbox')).toHaveClass('sc-pressing');
    act(() => { vi.advanceTimersByTime(150); });
    expect(flashing()).toBe(0);
    dispose();
    fireEvent.pointerDown(screen.getByTestId('checkbox'));
    expect(flashing()).toBe(0);
  });

  it('clears a flash on window blur', () => {
    render(<Harness />);
    const control = screen.getByTestId('disabled-child');
    fireEvent.pointerDown(control);
    expect(control).toHaveClass('sc-disabled-pressing');
    fireEvent(window, new Event('blur'));
    expect(flashing()).toBe(0);
  });

  it('reads the actual cursor after clearing an earlier flash on a rapid second press', () => {
    render(<Harness />);
    render(<input data-testid="text-input" />);
    fireEvent.pointerDown(screen.getByTestId('disabled-child'));
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
      cursor: flashing() > 0 ? 'not-allowed' : 'text',
    } as CSSStyleDeclaration));
    fireEvent.pointerDown(screen.getByTestId('text-input'));
    expect(flashing()).toBe(0);
  });
});
