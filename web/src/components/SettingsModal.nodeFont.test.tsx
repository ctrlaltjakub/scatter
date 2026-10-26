import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import { APP_FONT_EX_HEIGHT_RATIO } from '@/lib/imageEditFonts';
import { NodeFontRuntime } from './NodeFontRuntime';
import { SettingsModal } from './SettingsModal';

vi.mock('@/opfs/settingsIO', async original => ({
  ...await original<typeof import('@/opfs/settingsIO')>(), saveSettings: vi.fn(async () => {}),
}));

afterEach(() => {
  act(() => useSettingsStore.setState({ nodeFontId: 'app' }));
});

describe('node text font setting', () => {
  it('shows the font in its own face and changes the shared reading preference', () => {
    act(() => useSettingsStore.setState({ providers: [], activeModelRef: null, nodeFontId: 'app' }));
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    const picker = screen.getByRole('button', { name: 'Reading font' });
    expect(picker).toHaveTextContent('Atkinson Hyperlegible');
    fireEvent.click(picker);
    expect(screen.queryByRole('button', { name: /Press Start 2P/ })).not.toBeInTheDocument();
    expect((screen.getByRole('button', { name: /OpenDyslexic/ }).querySelector('.ie-dd-item-label') as HTMLElement).style.fontSizeAdjust)
      .toBe('0.496');
    expect((screen.getByRole('button', { name: /Comic Sans MS/ }).querySelector('.ie-dd-item-label') as HTMLElement).style.fontFamily)
      .toContain('Comic Sans MS');
    fireEvent.click(screen.getByRole('button', { name: /Comic Sans MS/ }));
    expect(useSettingsStore.getState().nodeFontId).toBe('comic-sans');
    expect(screen.getByRole('button', { name: 'Reading font' })).toHaveTextContent('Comic Sans MS');
  });

  it('normalizes alternate reading faces without adjusting the default', () => {
    const { unmount } = render(<NodeFontRuntime />);
    expect(document.documentElement.style.getPropertyValue('--sc-node-font-size-adjust')).toBe('');
    act(() => useSettingsStore.setState({ nodeFontId: 'opendyslexic' }));
    expect(document.documentElement.style.getPropertyValue('--sc-node-font-size-adjust'))
      .toBe(String(APP_FONT_EX_HEIGHT_RATIO));
    expect(document.documentElement.style.getPropertyValue('--sc-node-font-family'))
      .toContain('OpenDyslexic');
    act(() => useSettingsStore.setState({ nodeFontId: 'app' }));
    expect(document.documentElement.style.getPropertyValue('--sc-node-font-size-adjust')).toBe('');
    unmount();
  });
});
