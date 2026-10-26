import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalModelGuide } from './LocalModelGuide';

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});

function openGuide() {
  fireEvent.click(screen.getByRole('button', { name: 'Local providers: connection guide' }));
  const dialog = screen.getByRole('dialog', { name: 'Local provider connections' });
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 600, 500));
  return dialog;
}

function clickAt(dialog: HTMLElement, x: number, y: number, button = 0) {
  const point = { clientX: x, clientY: y, button };
  fireEvent.pointerDown(dialog, point);
  fireEvent.pointerUp(dialog, point);
  fireEvent.click(dialog, point);
}

describe('local provider connection guide', () => {
  it('documents app connection requirements and every supported search interface without server-installation instructions', () => {
    render(<LocalModelGuide />);
    const guide = within(openGuide());
    expect(guide.getByRole('heading', { name: 'API connection' })).toBeInTheDocument();
    expect(guide.getByText('GET /v1/models')).toBeInTheDocument();
    expect(guide.getByText('POST /v1/chat/completions')).toBeInTheDocument();
    for (const mode of ['LM Studio MCP', 'Responses + remote MCP', 'LocalAI']) {
      expect(guide.getByText((_text, element) => element?.tagName === 'STRONG' && element.textContent === `Server-managed · ${mode}:`)).toBeInTheDocument();
    }
    expect(guide.getByText((_text, element) => element?.tagName === 'STRONG' && element.textContent === 'Browser-managed · SearXNG:')).toBeInTheDocument();
    expect(guide.getByText('Show all models')).toBeInTheDocument();
    expect(guide.getByText('Test model capabilities')).toBeInTheDocument();
    expect(guide.queryByText(/Install|Download a model|MCP is a protocol/)).not.toBeInTheDocument();
    expect(guide.queryByRole('link', { name: /setup|download/i })).not.toBeInTheDocument();
  });

  it('shows the node-style preview on hover and focus without a link, click action or API call', () => {
    vi.useFakeTimers();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<LocalModelGuide />);
    const dialog = openGuide();
    const term = dialog.querySelector<HTMLElement>('[data-guide-term="CORS"]')!;
    expect(term).toHaveClass('ref-chip', 'unexplored');
    expect(term.tagName).toBe('SPAN');
    expect(term).not.toHaveAttribute('href');
    expect(term).not.toHaveAttribute('data-reference-term');
    fireEvent.mouseOver(term);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(120));
    const preview = screen.getByRole('tooltip');
    expect(dialog).toContainElement(preview);
    expect(preview).toHaveClass('relation-hover-preview', 'is-explanation');
    expect(preview.querySelectorAll('strong').length).toBeGreaterThanOrEqual(2);
    expect(term).toHaveAttribute('aria-describedby', preview.id);
    fireEvent.click(term);
    expect(dialog).toBeInTheDocument();
    expect(location.hash).toBe('');
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.mouseOut(term);
    act(() => vi.advanceTimersByTime(80));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(term).not.toHaveAttribute('aria-describedby');
    fireEvent.focus(term);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.scroll(dialog.querySelector('.local-guide-body')!);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('cancels delayed previews when the guide closes', () => {
    vi.useFakeTimers();
    render(<LocalModelGuide />);
    const dialog = openGuide();
    fireEvent.mouseOver(dialog.querySelector('[data-guide-term]')!);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close connection guide' }));
    act(() => vi.runAllTimers());
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on a backdrop click without triggering handlers in the underlying settings window', () => {
    const parentClick = vi.fn(), parentPointerDown = vi.fn();
    render(<div onClick={parentClick} onPointerDown={parentPointerDown}><span>Settings remain open</span><LocalModelGuide /></div>);
    const dialog = openGuide();
    parentClick.mockClear();
    clickAt(dialog, 50, 50);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Settings remain open')).toBeInTheDocument();
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentPointerDown).not.toHaveBeenCalled();
  });

  it('keeps content and empty space inside the dialog clickable without dismissing', () => {
    render(<LocalModelGuide />);
    const dialog = openGuide();
    clickAt(dialog, 110, 110);
    const heading = within(dialog).getByRole('heading', { name: 'Web search' });
    fireEvent.pointerDown(heading, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.click(heading, { clientX: 200, clientY: 200 });
    expect(dialog).toBeInTheDocument();
  });

  it('does not dismiss for drags between the content and backdrop, cancelled gestures, or a secondary click', () => {
    render(<LocalModelGuide />);
    const dialog = openGuide();
    const heading = within(dialog).getByRole('heading', { name: 'Web search' });
    fireEvent.pointerDown(heading, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.click(dialog, { clientX: 50, clientY: 50 });
    expect(dialog).toBeInTheDocument();
    fireEvent.pointerDown(dialog, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.click(dialog, { clientX: 110, clientY: 110 });
    expect(dialog).toBeInTheDocument();
    fireEvent.pointerDown(dialog, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerCancel(dialog);
    fireEvent.click(dialog, { clientX: 50, clientY: 50 });
    clickAt(dialog, 50, 50, 2);
    expect(dialog).toBeInTheDocument();
  });

  it('also closes through native Escape cancellation and the close button', () => {
    render(<LocalModelGuide />);
    fireEvent(openGuide(), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const dialog = openGuide();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close connection guide' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
