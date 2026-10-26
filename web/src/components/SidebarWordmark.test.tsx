import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarWordmark } from './SidebarWordmark';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { mutedAccentHex } from '@/lib/groupColor';
import { THEME_CHANGE_EVENT } from '@/lib/theme';

const colors = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.app-wordmark-letter')].map(el => el.style.color);
const css = (color: string) => { const span = document.createElement('span'); span.style.color = color; return span.style.color; };

beforeEach(() => {
  document.documentElement.dataset.theme = 'latte';
  useSettingsStore.setState({ accentHueShift: 33, accentDesaturate: 0, accentDarken: 20 });
  useGraphStore.setState({ project: { ...createBlankProject('Logo', 'root'), color: '#377eb8', groups: {} } });
  let seed = 7;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('shared sidebar wordmark', () => {
  it('opts out of underlined text links and rerandomizes on hover and keyboard focus', () => {
    const { container } = render(<SidebarWordmark />);
    const link = screen.getByRole('link', { name: 'Scatter landing page' });
    expect(link).toHaveAttribute('data-link-control');
    expect(link).toHaveAttribute('href', 'https://www.scatter.study/?landing=1');
    const initial = colors(container);
    fireEvent.mouseEnter(link);
    expect(colors(container)).not.toEqual(initial);
    const hovered = colors(container);
    fireEvent.focus(link);
    expect(colors(container)).not.toEqual(hovered);
  });

  it('uses the canvas accent for one-color projects and follows appearance/theme changes', () => {
    const { container } = render(<SidebarWordmark />);
    expect(new Set(colors(container))).toEqual(new Set([css('#377eb8'), css(mutedAccentHex('#377eb8', 33, 0, 20, 'light'))]));
    act(() => useSettingsStore.setState({ accentHueShift: 75, accentDarken: 10 }));
    expect(colors(container)).toContain(css(mutedAccentHex('#377eb8', 75, 0, 10, 'light')));
    act(() => { document.documentElement.dataset.theme = 'mocha'; window.dispatchEvent(new Event(THEME_CHANGE_EVENT)); });
    expect(colors(container)).toContain(css(mutedAccentHex('#377eb8', 75, 0, 10, 'dark')));
  });

  it('reshuffles every 500 ms only while hovered and cleans up on exit and unmount', () => {
    vi.useFakeTimers();
    const view = render(<SidebarWordmark />);
    const link = screen.getByRole('link');
    expect(vi.getTimerCount()).toBe(0);
    const project = useGraphStore.getState().project;
    fireEvent.mouseEnter(link);
    const first = colors(view.container);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(499));
    expect(colors(view.container)).toEqual(first);
    act(() => vi.advanceTimersByTime(1));
    const second = colors(view.container);
    expect(second).not.toEqual(first);
    act(() => vi.advanceTimersByTime(500));
    expect(colors(view.container)).not.toEqual(second);
    expect(useGraphStore.getState().project).toBe(project);
    fireEvent.mouseLeave(link);
    expect(vi.getTimerCount()).toBe(0);
    const stopped = colors(view.container);
    act(() => vi.advanceTimersByTime(1500));
    expect(colors(view.container)).toEqual(stopped);
    fireEvent.mouseEnter(link);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the latest restoration palette without accumulating hover timers', () => {
    vi.useFakeTimers();
    const view = render(<SidebarWordmark paletteOverride={['#e41a1c', '#1b9e77']} />);
    fireEvent.mouseEnter(screen.getByRole('link'));
    view.rerender(<SidebarWordmark paletteOverride={['#377eb8', '#d95f02']} />);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(500));
    expect(new Set(colors(view.container))).toEqual(new Set([css('#377eb8'), css('#d95f02')]));
  });

  it('keeps real group colors instead of adding an extra accent', () => {
    useGraphStore.setState(state => ({ project: { ...state.project!, groups: { group: { id: 'group', name: 'Group', color: '#d95f02', gravitate: false } } } }));
    const { container } = render(<SidebarWordmark />);
    expect(new Set(colors(container))).toEqual(new Set([css('#377eb8'), css('#d95f02')]));
  });

  it('reshuffles when focusing and unfocusing, without changing project state on hover', () => {
    const { container } = render(<SidebarWordmark />);
    act(() => useGraphStore.setState(state => ({ project: { ...state.project!, selection: ['root'] } })));
    const focused = colors(container);
    act(() => useGraphStore.setState(state => ({ project: { ...state.project!, selection: [] } })));
    expect(colors(container)).not.toEqual(focused);
    const project = useGraphStore.getState().project;
    fireEvent.mouseEnter(screen.getByRole('link'));
    expect(useGraphStore.getState().project).toBe(project);
  });

  it('preserves the restoration shell palette and its reshuffle control', () => {
    const view = render(<SidebarWordmark paletteOverride={['#e41a1c', '#1b9e77']} reshuffleToken={0} />);
    expect(new Set(colors(view.container))).toEqual(new Set([css('#e41a1c'), css('#1b9e77')]));
    const previous = colors(view.container);
    view.rerender(<SidebarWordmark paletteOverride={['#e41a1c', '#1b9e77']} reshuffleToken={1} />);
    expect(colors(view.container)).not.toEqual(previous);
  });
});
