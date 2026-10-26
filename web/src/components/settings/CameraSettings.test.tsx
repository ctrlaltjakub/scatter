import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { SettingsModal } from '../SettingsModal';

vi.mock('@/opfs/settingsIO', async original => ({ ...await original<typeof import('@/opfs/settingsIO')>(), saveSettings: vi.fn(async () => {}) }));
afterEach(() => act(() => useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } })));

describe('camera settings UI', () => {
  it('keeps all camera behaviors in a collapsed section at the bottom of Canvas and nodes', () => {
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas and nodes' }));
    const trigger = screen.getByRole('button', { name: 'Automatic camera movement' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('switch', { name: /When focusing a node/ })).not.toBeInTheDocument();
    expect(trigger.closest('.settings-pane')!.lastElementChild).toContainElement(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const names = ['When focusing a node', 'When selecting a group', 'When creating a node',
      'When creating a project from a branch', 'While generating content', 'While creating the first node', 'When expanding bullets',
      'When opening node panels', 'When starting the reading ruler', 'After deleting a node',
      'When dragging nodes near canvas edges'];
    for (const name of names) expect(screen.getByRole('switch', { name: new RegExp(name) })).toBeChecked();
    const section = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    expect(within(section).getAllByRole('switch')).toHaveLength(Object.keys(DEFAULT_SETTINGS.cameraAutoPan).length);
    fireEvent.click(screen.getByRole('switch', { name: /When focusing a node/ }));
    expect(useSettingsStore.getState().cameraAutoPan).toEqual({ ...DEFAULT_SETTINGS.cameraAutoPan, focus: false });
    expect(screen.getByRole('switch', { name: /When creating a node/ })).toBeChecked();
    for (const name of names.slice(1)) fireEvent.click(screen.getByRole('switch', { name: new RegExp(name) }));
    expect(Object.values(useSettingsStore.getState().cameraAutoPan).every(value => value === false)).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole('switch', { name: /When focusing a node/ })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    for (const name of names) expect(screen.getByRole('switch', { name: new RegExp(name) })).not.toBeChecked();
  });
});
