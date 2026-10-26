import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyThemePreference } from '@/lib/theme';
import { projectFaviconUrl } from '@/lib/favicon';
import { ProjectFavicon } from './ProjectFavicon';

const state = vi.hoisted(() => ({ project: null as { color: string } | null }));
vi.mock('@/store/useGraphStore', () => ({ useGraphStore: (selector: (s: typeof state) => unknown) => selector(state) }));

let icon: HTMLLinkElement;
const currentHref = () => document.querySelector('#project-favicon')?.getAttribute('href');
beforeEach(() => {
  state.project = null;
  icon = document.createElement('link');
  icon.rel = 'icon';
  icon.type = 'image/svg+xml';
  icon.href = '/favicon.svg';
  document.head.append(icon);
  applyThemePreference('dark', { persist: false });
});
afterEach(() => { icon.remove(); document.documentElement.style.removeProperty('--mauve'); });

describe('ProjectFavicon', () => {
  it('stays preferred when delayed page metadata inserts the static icon later', async () => {
    state.project = { color: '#1b9e77' };
    render(<ProjectFavicon />);
    await act(async () => { document.head.append(icon); });
    const icons = document.querySelectorAll('link[rel="icon"]');
    expect(icons[icons.length - 1]?.id).toBe('project-favicon');
    expect(currentHref()).toBe(projectFaviconUrl('#1b9e77'));
  });
  it('owns only one dynamic icon across Strict Mode remounts', () => {
    const view = render(<StrictMode><ProjectFavicon /></StrictMode>);
    expect(document.querySelectorAll('#project-favicon')).toHaveLength(1);
    expect(document.querySelectorAll('link[rel="icon"]')).toHaveLength(2);
    view.unmount();
    expect(document.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
  });
  it('updates on project switch, recoloring, theme change and project removal', () => {
    const view = render(<ProjectFavicon />);
    expect(currentHref()).toBe('/favicon.svg');
    state.project = { color: '#1b9e77' };
    view.rerender(<ProjectFavicon />);
    expect(currentHref()).toBe(projectFaviconUrl('#1b9e77'));
    state.project = { color: '#e7298a' };
    view.rerender(<ProjectFavicon />);
    expect(currentHref()).toBe(projectFaviconUrl('#e7298a'));
    act(() => { applyThemePreference('light', { persist: false }); });
    expect(currentHref()).toBe(projectFaviconUrl('#e7298a'));
    state.project = null;
    view.rerender(<ProjectFavicon />);
    expect(currentHref()).toBe('/favicon.svg');
  });
  it('resolves legacy named accents and restores the static icon on unmount', () => {
    state.project = { color: 'mauve' };
    document.documentElement.style.setProperty('--mauve', '#8839ef');
    const view = render(<ProjectFavicon />);
    expect(currentHref()).toBe(projectFaviconUrl('#8839ef'));
    expect(document.querySelector('link[rel="icon"]:last-of-type')?.id).toBe('project-favicon');
    expect(icon.getAttribute('href')).toBe('/favicon.svg');
    view.unmount();
    expect(document.querySelector('#project-favicon')).toBeNull();
    expect(icon.getAttribute('href')).toBe('/favicon.svg');
  });
  it('still refreshes named project colors when the theme changes', () => {
    state.project = { color: 'mauve' };
    document.documentElement.style.setProperty('--mauve', '#cba6f7');
    render(<ProjectFavicon />);
    expect(currentHref()).toBe(projectFaviconUrl('#cba6f7'));
    act(() => {
      document.documentElement.style.setProperty('--mauve', '#8839ef');
      applyThemePreference('light', { persist: false });
    });
    expect(currentHref()).toBe(projectFaviconUrl('#8839ef'));
  });
});
