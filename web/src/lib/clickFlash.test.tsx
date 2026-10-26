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
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.classList.remove('sc-pressing', 'sc-disabled-pressing');
  });

  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('sc-pressing', 'sc-disabled-pressing');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('briefly shows the disabled cursor when an aria-disabled control is pressed', () => {
    render(<Harness />);

    fireEvent.pointerDown(screen.getByTestId('disabled-child'));

    expect(document.documentElement).toHaveClass('sc-disabled-pressing');
    expect(document.documentElement).not.toHaveClass('sc-pressing');

    act(() => { vi.advanceTimersByTime(150); });
    expect(document.documentElement).not.toHaveClass('sc-disabled-pressing');
  });

  it.each(['pointer', 'default', 'text', 'grab'])('recognizes the %s fallback after an image-set cursor', fallback => {
    render(<button type="button" data-testid="cursor-control">Control</button>);
    render(<Harness />);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      cursor: `image-set(url("data:image/png;base64,a") 1x, url("data:image/png;base64,b") 2x) 3 3, ${fallback}`,
    } as CSSStyleDeclaration);
    fireEvent.pointerDown(screen.getByTestId('cursor-control'));
    expect(document.documentElement.classList.contains('sc-pressing')).toBe(['pointer', 'default'].includes(fallback));
    act(() => { vi.advanceTimersByTime(150); });
    expect(document.documentElement).not.toHaveClass('sc-pressing');
  });

  it('works from its serialized sandbox source and clears feedback after a quick click', () => {
    const install = (0, eval)(`(${installClickFlash.toString()})`) as typeof installClickFlash;
    const dispose = install(document);
    render(<label><input type="checkbox" data-testid="checkbox" />Enabled</label>);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ cursor: 'pointer' } as CSSStyleDeclaration);
    fireEvent.pointerDown(screen.getByTestId('checkbox'));
    fireEvent.pointerUp(screen.getByTestId('checkbox'));
    expect(document.documentElement).toHaveClass('sc-pressing');
    act(() => { vi.advanceTimersByTime(150); });
    expect(document.documentElement).not.toHaveClass('sc-pressing');
    dispose();
    fireEvent.pointerDown(screen.getByTestId('checkbox'));
    expect(document.documentElement).not.toHaveClass('sc-pressing');
  });

  it('clears a flash on window blur', () => {
    render(<Harness />);
    const control = screen.getByTestId('disabled-child');
    fireEvent.pointerDown(control);
    expect(document.documentElement).toHaveClass('sc-disabled-pressing');
    fireEvent(window, new Event('blur'));
    expect(document.documentElement).not.toHaveClass('sc-disabled-pressing');
  });

  it('reads the actual cursor after clearing an earlier flash on a rapid second press', () => {
    render(<Harness />);
    render(<input data-testid="text-input" />);
    fireEvent.pointerDown(screen.getByTestId('disabled-child'));
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
      cursor: document.documentElement.classList.contains('sc-disabled-pressing') ? 'not-allowed' : 'text',
    } as CSSStyleDeclaration));
    fireEvent.pointerDown(screen.getByTestId('text-input'));
    expect(document.documentElement).not.toHaveClass('sc-pressing', 'sc-disabled-pressing');
  });
});
