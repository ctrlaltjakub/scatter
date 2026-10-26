import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { useSettingsStore } from '@/store/useSettingsStore';

// This UI test changes a setting; its delayed autosave must not reach browser
// filesystem APIs that are absent from the DOM test environment.
vi.mock('@/opfs/settingsIO', async original => ({
  ...await original<typeof import('@/opfs/settingsIO')>(), saveSettings: vi.fn(async () => {}),
}));

describe('SettingsModal canvas tab naming', () => {
  beforeEach(() => {
    useSettingsStore.setState({ groupColorAssignment: 'opposites' });
  });

  it('calls both the tab and its heading Canvas and nodes', () => {
    const view = render(<SettingsModal open onClose={() => {}} />);
    const tab = view.getByRole('button', { name: 'Canvas and nodes' });
    fireEvent.click(tab);
    expect(view.getAllByText('Canvas and nodes')).toHaveLength(2);
  });

  it('exposes both automatic color systems without recoloring on selection', () => {
    const view = render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(view.getByRole('button', { name: 'Appearance' }));

    const select = view.getByLabelText('Automatic assignment');
    expect(select).toHaveValue('opposites');
    fireEvent.change(select, { target: { value: 'hierarchy-aware' } });
    expect(useSettingsStore.getState().groupColorAssignment).toBe('hierarchy-aware');
    expect(view.getByRole('button', { name: 'Reassign current project colors' }))
      .toBeInTheDocument();
  });
});
