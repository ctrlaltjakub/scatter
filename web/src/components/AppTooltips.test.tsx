import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTooltips, controlTooltipScale, controlTooltipText, TOOLTIP_DELAY_MS } from './AppTooltips';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';

const tick = (ms = TOOLTIP_DELAY_MS) => act(() => vi.advanceTimersByTime(ms));
function setup() {
  return render(<>
    <button data-tip="Generate a new answer" aria-describedby="existing-description">Generate</button>
    <span id="existing-description">Existing description</span>
    <button aria-label="Settings"><svg /></button>
    <button disabled data-tip="Choose a model first">Unavailable</button>
    <button title="Copy the source Markdown">Copy text</button>
    <button>Save changes</button>
    <span role="button" tabIndex={0} data-reference-term="cache" data-tip="Explore cache">cache</span>
    <AppTooltips />
  </>);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useLiveViewportStore.getState().clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('app-wide floating tooltips', () => {
  it('has no idle UI and waits before showing the preview-styled, icon-free surface', () => {
    setup();
    expect(screen.queryByRole('tooltip')).toBeNull();
    const button = screen.getByRole('button', { name: 'Generate' });
    fireEvent.mouseOver(button);
    tick(TOOLTIP_DELAY_MS - 1);
    expect(screen.queryByRole('tooltip')).toBeNull();
    tick(1);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveClass('relation-hover-preview', 'app-control-tooltip');
    expect(tooltip).toHaveTextContent('Generate a new answer');
    expect(tooltip.querySelector('svg')).toBeNull();
    expect(button).toHaveAttribute('aria-describedby', 'existing-description scatter-control-tooltip');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button).toHaveAttribute('aria-describedby', 'existing-description');
  });
  it('uses accessible names and visible labels when a button has no explicit description', () => {
    setup();
    const settings = screen.getByRole('button', { name: 'Settings' });
    fireEvent.mouseOver(settings.querySelector('svg')!); tick();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Settings');
    fireEvent.mouseOver(screen.getByRole('button', { name: 'Save changes' }));
    tick();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Save changes');
  });
  it('treats an empty description as an opt-out, without falling back to prose or an ancestor', () => {
    render(<><div data-tip="Outer action"><div role="button" tabIndex={0} data-tip="" aria-label="A full section of content">
      <p>Information and timing. A long explanation of simultaneous and sequential games.</p>
      <button data-tip="Copy text">Copy</button>
    </div></div><AppTooltips /></>);
    const section = screen.getByRole('button', { name: 'A full section of content' });
    expect(controlTooltipText(section)).toBe('');
    fireEvent.mouseOver(section.querySelector('p')!); tick();
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.keyDown(document, { key: 'Tab' }); fireEvent.focusIn(section);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseOver(screen.getByRole('button', { name: 'Copy' })); tick();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Copy text');
  });
  it.each(['A complete paragraph.', '説明の長い文章。', 'فقرة كاملة بالعربية.', 'एक पूरा अनुच्छेद।'])
    ('does not infer a tooltip from an unnamed content wrapper: %s', prose => {
      render(<><div role="button" tabIndex={0}><p>{prose}</p></div><AppTooltips /></>);
      fireEvent.mouseOver(screen.getByText(prose)); tick();
      expect(screen.queryByRole('tooltip')).toBeNull();
    });
  it('dismisses a visible action hint when the control explicitly disables its tooltip', async () => {
    render(<><div role="button" data-tip="Click to expand bullet">Full expanded contents</div><AppTooltips /></>);
    const section = screen.getByRole('button');
    fireEvent.mouseOver(section); tick();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Click to expand bullet');
    await act(async () => section.setAttribute('data-tip', ''));
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseOver(section); tick();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it.each([0, 150])('waits the full delay for a neighboring control after a %sms gap', (gap) => {
    setup();
    const first = screen.getByRole('button', { name: 'Generate' });
    const next = screen.getByRole('button', { name: 'Settings' });
    fireEvent.mouseOver(first); tick();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Generate a new answer');
    fireEvent.mouseOut(first, { relatedTarget: gap ? document.body : next });
    tick(gap);
    fireEvent.mouseOver(next);
    expect(screen.queryByRole('tooltip')).toBeNull();
    tick(TOOLTIP_DELAY_MS - 1);
    expect(screen.queryByRole('tooltip')).toBeNull();
    tick(1);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Settings');
  });
  it('restarts the delay when moving between controls before a tooltip appears', () => {
    setup();
    const first = screen.getByRole('button', { name: 'Generate' });
    const next = screen.getByRole('button', { name: 'Settings' });
    fireEvent.mouseOver(first); tick(TOOLTIP_DELAY_MS - 1);
    fireEvent.mouseOut(first, { relatedTarget: next });
    fireEvent.mouseOver(next);
    tick(TOOLTIP_DELAY_MS - 1);
    expect(screen.queryByRole('tooltip')).toBeNull();
    tick(1);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Settings');
  });
  it('shows disabled-button explanations and responds to live description changes', async () => {
    setup();
    const button = screen.getByRole('button', { name: 'Unavailable' });
    fireEvent.mouseOver(button); tick();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Choose a model first');
    await act(async () => button.setAttribute('data-tip', 'This task is running'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('This task is running');
  });
  it('replaces native titles while hovered, then restores them when leaving', () => {
    setup();
    const button = screen.getByRole('button', { name: 'Copy text' });
    fireEvent.mouseOver(button); tick();
    expect(button).not.toHaveAttribute('title');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Copy the source Markdown');
    fireEvent.mouseOut(button, { relatedTarget: document.body }); tick(120);
    expect(button).toHaveAttribute('title', 'Copy the source Markdown');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('preserves the accessible name of an icon button that uses only a native title', () => {
    render(<><button title="Close"><svg /></button><AppTooltips /></>);
    const button = screen.getByRole('button', { name: 'Close' });
    fireEvent.mouseOver(button); tick();
    expect(button).not.toHaveAttribute('title');
    expect(screen.getByRole('button', { name: 'Close' })).toBe(button);
    fireEvent.mouseOut(button, { relatedTarget: document.body }); tick(120);
    expect(button).toHaveAttribute('title', 'Close');
    expect(button).not.toHaveAttribute('aria-label');
  });
  it('opens immediately for keyboard focus and closes on blur or activation', () => {
    setup();
    const button = screen.getByRole('button', { name: 'Settings' });
    fireEvent.keyDown(document, { key: 'Tab' }); fireEvent.focusIn(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Settings');
    fireEvent.blur(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focusIn(button);
    fireEvent.pointerDown(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('never competes with a term preview, even under a tooltip-bearing ancestor', () => {
    setup();
    const term = screen.getByRole('button', { name: 'cache' });
    fireEvent.mouseOver(term); tick();
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.keyDown(document, { key: 'Tab' }); fireEvent.focusIn(term); tick();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('leaves embedded-document titles and controls alone', () => {
    render(<><iframe title="Interactive program" /><AppTooltips /></>);
    const frame = screen.getByTitle('Interactive program');
    fireEvent.mouseOver(frame); tick();
    expect(frame).toHaveAttribute('title', 'Interactive program');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.keyDown(document, { key: 'Tab' }); fireEvent.focusIn(frame); tick();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('allows hovering the tooltip and dismisses it immediately on outside scroll', () => {
    setup();
    const button = screen.getByRole('button', { name: 'Generate' });
    fireEvent.mouseOver(button); tick();
    const tooltip = screen.getByRole('tooltip');
    fireEvent.mouseOut(button, { relatedTarget: tooltip }); fireEvent.mouseOver(tooltip); tick(1000);
    expect(tooltip).toBeVisible();
    fireEvent.scroll(tooltip);
    expect(tooltip).toBeVisible();
    fireEvent.scroll(document);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('removes a tooltip whose control is deleted and cancels timers during unmount', async () => {
    const view = render(<><div><button aria-label="Settings"><svg /></button></div><AppTooltips /></>);
    const button = screen.getByRole('button', { name: 'Settings' });
    fireEvent.mouseOver(button); tick();
    await act(async () => view.rerender(<><div /><AppTooltips /></>));
    expect(screen.queryByRole('tooltip')).toBeNull();
    view.rerender(<><div><button>Save changes</button></div><AppTooltips /></>);
    fireEvent.mouseOver(screen.getByRole('button', { name: 'Save changes' }));
    view.unmount(); tick();
    expect(document.querySelector('#scatter-control-tooltip')).toBeNull();
  });
  it('resolves labelled controls without putting the tooltip into the button name', () => {
    const view = render(<><span id="label">Select font</span><button aria-labelledby="label" /><label><input type="checkbox" />Show all models</label></>);
    expect(controlTooltipText(view.container.querySelector('button')!)).toBe('Select font');
    expect(controlTooltipText(view.container.querySelector('input')!)).toBe('Show all models');
  });
  it.each([100, 10])('places action-menu tooltips above, flipping below only near the top edge (y=%s)', (top) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'tooltip') return new DOMRect(0, 0, 280, 32);
      return new DOMRect(300, top, 180, 40);
    });
    render(<><div className="side-panel-content"><button className="side-action">Add a chat</button></div><AppTooltips /></>);
    fireEvent.mouseOver(screen.getByRole('button')); tick();
    expect(screen.getByRole('tooltip')).toHaveStyle({
      left: '250px', top: `${top === 100 ? 62 : 56}px`, pointerEvents: 'none',
    });
  });
  it.each(['border-box', 'content-box'])('measures actual control scaling with %s sizing, not global camera zoom', (boxSizing) => {
    const view = render(<button style={{ width: boxSizing === 'border-box' ? 120.75 : 100.75, boxSizing: boxSizing as 'border-box' | 'content-box',
      padding: 8, border: '2px solid' }}>Action</button>);
    const button = view.container.querySelector('button')!;
    expect(controlTooltipScale(button, new DOMRect(0, 0, 60.375, 20))).toBe(0.5);
    useLiveViewportStore.getState().setZoom(0.5);
    expect(controlTooltipScale(button, new DOMRect(0, 0, 120.75, 40))).toBe(1);
  });
  it('uses the full layout width of auto-sized inline controls, not just their padding', () => {
    const view = render(<span data-tip="More information" style={{ width: 'auto', padding: 4 }}>Info</span>);
    const element = view.container.querySelector('span')!;
    Object.defineProperty(element, 'offsetWidth', { value: 100 });
    expect(controlTooltipScale(element, new DOMRect(0, 0, 50, 20))).toBe(0.5);
  });
  it('keeps a visible tooltip anchored and scaled across camera zoom and pan', () => {
    let zoom = 1, x = 300, y = 200;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'tooltip') {
        const scale = Number(this.style.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
        return new DOMRect(0, 0, 280 * scale, 32 * scale);
      }
      return new DOMRect(x, y, 200 * zoom, 40 * zoom);
    });
    render(<><button style={{ width: 200, boxSizing: 'border-box' }}>Canvas action</button><AppTooltips /></>);
    fireEvent.mouseOver(screen.getByRole('button')); tick();
    expect(screen.getByRole('tooltip')).toHaveStyle({ transform: 'scale(1)', left: '260px', top: '162px' });
    zoom = 0.5;
    act(() => useLiveViewportStore.getState().setZoom(zoom)); tick(20);
    expect(screen.getByRole('tooltip')).toHaveStyle({ transform: 'scale(0.5)', left: '280px', top: '181px' });
    x += 50; y += 20;
    act(() => useLiveViewportStore.getState().setPan(50, 20)); tick(20);
    expect(screen.getByRole('tooltip')).toHaveStyle({ transform: 'scale(0.5)', left: '330px', top: '201px' });
  });
  it('keeps a click-through tooltip readable while the pointer is over its visual bounds', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tooltip' ? new DOMRect(50, 100, 100, 20) : new DOMRect(50, 140, 100, 30);
    });
    render(<><button>Action</button><AppTooltips /></>);
    const button = screen.getByRole('button');
    fireEvent.mouseOver(button, { clientX: 100, clientY: 150 }); tick();
    fireEvent.mouseOut(button, { relatedTarget: document.body });
    fireEvent.mouseOver(document.body, { clientX: 100, clientY: 110 }); tick(1000);
    expect(screen.getByRole('tooltip')).toHaveStyle({ pointerEvents: 'none' });
    fireEvent.mouseMove(document.body, { clientX: 500, clientY: 500 }); tick(120);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
