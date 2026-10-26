import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFontSettings } from './NodeFontSettings';
import { useSettingsStore } from '@/store/useSettingsStore';
import { customFontFixture as font } from '@/test/customFontFixture';
import { readCustomNodeFont } from '@/lib/customNodeFontRuntime';

vi.mock('@/opfs/settingsIO', async original => ({
  ...await original<typeof import('@/opfs/settingsIO')>(), saveSettings: vi.fn(async () => {}),
}));
vi.mock('@/lib/customNodeFontRuntime', async original => ({
  ...await original<typeof import('@/lib/customNodeFontRuntime')>(),
  readCustomNodeFont: vi.fn(), loadCustomNodeFont: vi.fn(async () => {}),
}));
beforeEach(() => {
  useSettingsStore.setState({ customNodeFonts: [], nodeFontId: 'app' });
  vi.mocked(readCustomNodeFont).mockResolvedValue(font);
});
afterEach(() => { vi.clearAllMocks(); });

function upload() {
  fireEvent.change(screen.getByLabelText('Upload custom font files'), { target: { files: [new File(['font'], 'My-Caveat.woff2')] } });
}

describe('custom font settings', () => {
  it('groups the picker and upload control above compact font rows and their notes', () => {
    useSettingsStore.setState({ customNodeFonts: [font], nodeFontId: font.id });
    render(<NodeFontSettings />);
    const group = screen.getByRole('group', { name: 'Font' });
    const controls = within(group).getByRole('button', { name: 'Reading font' }).closest('.settings-font-controls')!;
    expect(within(group).getByRole('heading', { name: 'Font' })).toBeInTheDocument();
    expect(group).toHaveTextContent('Used for node titles and text, including chats.');
    expect(group.querySelector('.settings-reading-subheading p')).toHaveTextContent('whole node or chat answer');
    expect(screen.queryByText('Node text font')).not.toBeInTheDocument();
    expect(within(controls as HTMLElement).getByRole('button', { name: 'Upload fonts' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Uploaded fonts' });
    const listHeading = screen.getByRole('heading', { name: 'Uploaded fonts' });
    expect(controls.compareDocumentPosition(listHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(listHeading.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const name = within(list).getByRole('textbox', { name: 'Font name: My Caveat' });
    const row = name.closest('.settings-custom-font-row')!;
    expect(row.querySelector('.settings-custom-font-meta')).toHaveTextContent('WOFF2 ·');
    expect(row.querySelector('.settings-custom-font-meta')?.parentElement).toBe(name.parentElement);
    const count = screen.getByText('Custom fonts · 1/20');
    const notes = screen.getByText(/Font files are included in/);
    expect(controls.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/Text editors/)).not.toBeInTheDocument();
  });
  it('uploads, previews, selects, renames, and immediately removes the active font', async () => {
    render(<NodeFontSettings />);
    expect(screen.getByText(/Font files are included in/)).toHaveTextContent('settings exports and sync');
    upload();
    await screen.findByRole('button', { name: 'Use My Caveat' });
    expect(useSettingsStore.getState().nodeFontId).toBe('app');
    fireEvent.click(screen.getByRole('button', { name: 'Reading font' }));
    const option = screen.getByRole('button', { name: /My Caveat\s*Custom font/ });
    expect((option.querySelector('.ie-dd-item-label') as HTMLElement).style.fontFamily).toContain('ScatterCustomFont_');
    fireEvent.click(option);
    expect(useSettingsStore.getState().nodeFontId).toBe(font.id);
    const name = screen.getByRole('textbox', { name: 'Font name: My Caveat' });
    fireEvent.change(name, { target: { value: 'My handwriting' } }); fireEvent.blur(name);
    expect(useSettingsStore.getState().customNodeFonts[0]?.name).toBe('My handwriting');
    fireEvent.click(screen.getByRole('button', { name: 'Remove My handwriting' }));
    expect(useSettingsStore.getState()).toMatchObject({ nodeFontId: 'app', customNodeFonts: [] });
    expect(screen.getByRole('button', { name: 'Reading font' })).toHaveTextContent('Atkinson Hyperlegible');
    expect(screen.queryByRole('list', { name: 'Uploaded fonts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove font' })).not.toBeInTheDocument();
  });
  it('immediately removes an unused font without changing the active typeface', () => {
    useSettingsStore.setState({ customNodeFonts: [font], nodeFontId: 'inter' });
    render(<NodeFontSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove My Caveat' }));
    expect(useSettingsStore.getState()).toMatchObject({ nodeFontId: 'inter', customNodeFonts: [] });
    expect(screen.getByRole('button', { name: 'Reading font' })).toHaveTextContent('Inter');
    expect(screen.getByText('Custom fonts · 0/20')).toBeInTheDocument();
  });
  it('does not duplicate the same file or replace the chosen font on errors', async () => {
    useSettingsStore.setState({ customNodeFonts: [font], nodeFontId: font.id });
    render(<NodeFontSettings />); upload();
    await screen.findByText(/already in your list/);
    expect(useSettingsStore.getState().customNodeFonts).toHaveLength(1);
    vi.mocked(readCustomNodeFont).mockRejectedValueOnce(new Error('Invalid font'));
    upload();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid font');
    expect(useSettingsStore.getState()).toMatchObject({ nodeFontId: font.id, customNodeFonts: [font] });
  });
  it('preserves a sync update that arrives while a font file is being read', async () => {
    let finish!: (value: typeof font) => void;
    vi.mocked(readCustomNodeFont).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<NodeFontSettings />); upload();
    const remote = { ...font, id: `custom-font-${'b'.repeat(64)}`, name: 'Remote', data: font.data + 'AAAA' };
    act(() => useSettingsStore.setState({ customNodeFonts: [remote], nodeFontId: remote.id }));
    await act(async () => { finish(font); });
    await waitFor(() => expect(useSettingsStore.getState().customNodeFonts).toEqual([remote, font]));
    expect(useSettingsStore.getState().nodeFontId).toBe(remote.id);
  });
});
