import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useSyncStore } from '@/store/useSyncStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { defaultSyncConfig, defaultSyncLedger } from '@/sync/local';
import { DEFAULT_PROMPTS } from '@/lib/promptDefaults';
import { FIELD_LABELS } from './dev/PromptsEditor';
import { KEY_ACTIONS } from '@/lib/keymap';
import { SETTINGS_PAGES } from './settings/settingsNavigation';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { colorToCss } from '@/lib/groupColor';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => undefined), loadSettings: vi.fn() }));

beforeEach(() => {
  useSettingsStore.setState({
    ...DEFAULT_SETTINGS,
    providers: [],
    activeModelRef: null,
    customPrompts: undefined,
    keybindings: {},
  });
  useSyncStore.setState({
    hydrated: true,
    config: defaultSyncConfig(),
    ledger: defaultSyncLedger(),
    running: false,
    error: null,
    projectHistory: {},
    preferenceHistory: [],
  });
});
afterEach(() => vi.restoreAllMocks());

function go(name: string) {
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Settings categories' })).getByRole('button', { name }),
  );
}

describe('redesigned settings', () => {
  it('uses the current project tint for panels and keeps disclosure headings inside their panels', () => {
    const project = { ...createBlankProject('Settings preview', 'root'), color: '#ad4f7e' };
    useGraphStore.setState({ project });
    const view = render(<SettingsModal open initialPage="canvas" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.style.getPropertyValue('--settings-accent')).toBe(colorToCss(project.color));
    for (const title of ['Chat', 'Writing', 'Text selection web search']) {
      expect(screen.getByRole('heading', { name: title, level: 3 }).closest('.settings-section')).toBeInTheDocument();
    }
    const camera = screen.getByRole('button', { name: 'Automatic camera movement' });
    const panel = camera.closest('.settings-collapsible');
    expect(panel).toBeInTheDocument();
    fireEvent.click(camera);
    expect(camera).toHaveAttribute('aria-expanded', 'true');
    expect(camera.closest('.settings-collapsible')).toBe(panel);
    act(() => useGraphStore.setState({ project: { ...project, color: '#4da77c' } }));
    expect(dialog.style.getPropertyValue('--settings-accent')).toBe(colorToCss('#4da77c'));
    act(() => useGraphStore.setState({ project: null }));
    expect(dialog.style.getPropertyValue('--settings-accent')).toBe('var(--mauve)');
    view.unmount();
  });
  it('opens the requested page and clears a previous settings search on reopening', () => {
    const props = { open: true, onClose: vi.fn() };
    const view = render(<SettingsModal {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search settings' }), { target: { value: 'font' } });
    view.rerender(<SettingsModal {...props} open={false} />);
    view.rerender(<SettingsModal {...props} initialPage="sync" />);
    expect(screen.getByRole('heading', { name: 'Synchronization' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search settings' })).toHaveValue('');
    expect(screen.getByRole('region', { name: 'Projects and settings' })).toBeInTheDocument();
  });

  it('defaults previews on and image search off, with independent controls', () => {
    render(<SettingsModal open onClose={() => {}} />);
    go('Models and generation');
    fireEvent.click(screen.getByRole('button', { name: 'Automatic enrichment' }));
    const previews = screen.getByRole('switch', { name: /Generate term previews automatically/ });
    const images = screen.getByRole('switch', { name: /Search for free images automatically/ });
    expect(images).toHaveAccessibleName(/Wikimedia Commons and Openverse/);
    expect(images).toHaveAccessibleName(/for encyclopedic and answer nodes/);
    expect(images).not.toHaveAccessibleName(/Excludes explain/);
    expect(images).toHaveAccessibleName(/Use Search for free images in a node’s panel to search manually/);
    expect(previews).toBeChecked(); expect(images).not.toBeChecked();
    fireEvent.click(previews);
    expect(useSettingsStore.getState().autoTermPreviews).toBe(false);
    expect(images).not.toBeChecked();
    fireEvent.click(images);
    expect(useSettingsStore.getState().autoFreeImages).toBe(true);
  });
  it('documents contextual shortcuts including editors, image regions, and chat stop', () => {
    render(<SettingsModal open onClose={() => {}} />);
    go('Shortcuts');
    const table = screen.getByRole('table', { name: 'Contextual shortcuts' });
    expect(table).toHaveTextContent('Stop generating the focused chat answer');
    expect(table).toHaveTextContent('Select image parts over annotations');
    expect(table).toHaveTextContent('Demote a bullet');
  });
  it('keeps all destinations reachable and identifies the selected page', () => {
    render(<SettingsModal open onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Appearance', level: 2 })).toBeInTheDocument();
    for (const page of SETTINGS_PAGES) {
      if (page.id === 'openrouter') {
        expect(within(screen.getByRole('navigation', { name: 'Settings categories' })).getByRole('button', { name: 'OpenRouter' })).toBeDisabled();
        continue;
      }
      go(page.label);
      expect(screen.getByRole('heading', { name: page.label, level: 2 })).toBeInTheDocument();
      for (const paragraph of document.querySelectorAll('.settings-modal p')) {
        expect(paragraph.textContent).not.toMatch(/[a-z]\.[A-Z]/);
        // Descriptions refer to the app, while the actual export extension
        // remains .scatter.zip. Do not inspect editable AI prompt contents.
        expect(paragraph.textContent?.replaceAll('.scatter.zip', '')).not.toMatch(/\bscatter\b/i);
      }
      expect(
        within(screen.getByRole('navigation')).getByRole('button', { name: page.label }),
      ).toHaveAttribute('aria-current', 'page');
    }
  });

  it('searches setting concepts, opens results, and clears search before closing on Escape', () => {
    const onClose = vi.fn();
    render(<SettingsModal open onClose={onClose} />);
    const search = screen.getByRole('textbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'font' } });
    expect(screen.getByText('1 category matching “font”')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Appearance' }));
    expect(search).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Reading font' })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'nonsense' } });
    expect(screen.getByText('No settings found')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('preserves theme, accent, paragraph, Enter-key, and grouping choices', () => {
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('mocha');
    fireEvent.change(screen.getByRole('slider', { name: 'Saturation' }), { target: { value: '-35' } });
    expect(useSettingsStore.getState().accentDesaturate).toBe(DEFAULT_SETTINGS.accentDesaturate);
    fireEvent.pointerUp(screen.getByRole('slider', { name: 'Saturation' }));
    expect(useSettingsStore.getState().accentDesaturate).toBe(35);
    const before = useSettingsStore.getState().sentencePerLine;
    fireEvent.click(screen.getByRole('switch', { name: /One sentence per line/ }));
    expect(useSettingsStore.getState().sentencePerLine).toBe(!before);
    fireEvent.change(screen.getByLabelText('Automatic assignment'), { target: { value: 'golden-angle' } });
    expect(useSettingsStore.getState().groupColorAssignment).toBe('golden-angle');
    expect(screen.getByLabelText('Node text preview')).toBeInTheDocument();
    go('Canvas and nodes');
    fireEvent.change(screen.getByLabelText('Enter key'), { target: { value: 'newline' } });
    expect(useSettingsStore.getState().followUpEnterSends).toBe(false);
  });

  it('keeps every prompt editable and searchable without saved versions', () => {
    render(<SettingsModal open onClose={() => {}} />);
    go('Canvas and nodes');
    fireEvent.change(screen.getByLabelText('Chat instructions'), {
      target: { value: 'Give concrete examples.' },
    });
    expect(useSettingsStore.getState().normalChatInstructions).toBe('Give concrete examples.');
    go('System prompts');
    expect(screen.queryByText('Saved prompt versions')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save version' })).toBeNull();
    expect(screen.getByText('Custom system prompts can break generation.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Chat instructions')).not.toBeInTheDocument();
    // The per-field editing matrix lives in PromptsEditor.test.tsx. Check all
    // labels here without expanding 79 large textareas in one integration test.
    const labels = screen.getAllByRole('button').map(button => button.getAttribute('aria-label'));
    for (const label of Object.values(FIELD_LABELS)) expect(labels).toContain(label);
    fireEvent.click(screen.getByRole('button', { name: FIELD_LABELS.chatBase }));
    expect(screen.getByRole('textbox', { name: FIELD_LABELS.chatBase })).toHaveValue(DEFAULT_PROMPTS.chatBase);
    expect(screen.queryByText('Physics', { exact: true })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search prompts' }), {
      target: { value: 'fact' },
    });
    expect(screen.getByRole('button', { name: FIELD_LABELS.taskFactCheckUnit })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: FIELD_LABELS.base })).not.toBeInTheDocument();
  });

  it('warns about developer resets and removes layout history while keeping reset controls', () => {
    render(<SettingsModal open onClose={() => {}} />);
    go('Developer');
    expect(screen.getByText('Developer overrides can break layout or performance.')).toBeInTheDocument();
    expect(screen.queryByText('Saved dev settings versions')).toBeNull();
    for (const section of ['Physics', 'Bullet sizing']) {
      fireEvent.click(screen.getByRole('button', { name: section }));
    }
    expect(screen.queryByRole('button', { name: 'Save version' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Reset$/ })).toHaveLength(2);
    expect(screen.queryByText('Prompt banner')).toBeNull();
  });

  it('keeps all shortcuts and does not close the dialog when cancelling rebinding', () => {
    const onClose = vi.fn();
    render(<SettingsModal open onClose={onClose} />);
    go('Shortcuts');
    for (const action of KEY_ACTIONS)
      expect(within(screen.getByRole('table', { name: 'Canvas and app shortcuts' })).getByText(action.label, { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change Fullscreen shortcut' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change Fullscreen shortcut' }));
    fireEvent.keyDown(window, { key: 'j', altKey: true });
    expect(useSettingsStore.getState().keybindings?.fullscreen).toEqual([{ key: 'j', alt: true }]);
  });

  it('retains both sync providers, all WebDAV fields, and sync history', () => {
    render(<SettingsModal open onClose={() => {}} />);
    go('Synchronization');
    expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'WebDAV / Nextcloud' }));
    for (const label of ['Server WebDAV URL', 'Username', 'App password', 'Remote folder'])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByLabelText('Remote folder')).toHaveValue('Scatter Sync');
    expect(screen.getByText(/lets the app store files on your own server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect WebDAV' })).toBeInTheDocument();
    act(() =>
      useSyncStore.setState({ config: { ...defaultSyncConfig(), enabled: true, provider: 'google-drive' } }),
    );
    for (const label of ['Sync now', 'Pause automatic syncing', 'Disconnect'])
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    expect(screen.getByLabelText("This device's name")).toBeInTheDocument();
    expect(screen.getByLabelText('History for')).toBeInTheDocument();
    act(() => useSyncStore.setState({ error: 'Connection expired' }));
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('retains import/export and puts irreversible actions behind confirmation', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onClose = vi.fn();
    render(<SettingsModal open onClose={onClose} />);
    go('Backups');
    for (const name of ['Export project', 'Import project', 'Export settings', 'Import settings'])
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Erase project data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove all app data' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('adds a provider, cleans pasted keys, enables models, and assigns the main role', async () => {
    const catalog = [{ id: 'gpt-5.6-luna', caps: { textOutput: true, vision: true, tools: true } }];
    const refresh = vi.spyOn(useModelCatalogStore.getState(), 'refreshCatalog').mockImplementation(async (id) => {
      useModelCatalogStore.getState().setCatalog(id, catalog);
      return catalog;
    });
    render(<SettingsModal open onClose={() => {}} />);
    go('AI providers');
    fireEvent.change(screen.getByLabelText('Choose a provider'), { target: { value: 'openai' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: ' sk- test\n\u200B ' } });
    expect(useSettingsStore.getState().providers[0]?.apiKey).toBe('sk-test');
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByText('Main model library')).not.toBeInTheDocument();
    go('Models and generation');
    fireEvent.click(screen.getByRole('button', { name: /^Main model/ }));
    const model = await screen.findByRole('button', { name: /^gpt-5.6-luna/ });
    fireEvent.click(model);
    expect(model).toHaveAttribute('aria-pressed', 'true');
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('gpt-5.6-luna');
  });

  it('keeps saved models available if catalog refresh fails', async () => {
    vi.spyOn(useModelCatalogStore.getState(), 'refreshCatalog').mockRejectedValue(new Error('Offline'));
    useSettingsStore.setState({
      providers: [{ id: 'saved', preset: 'openai', apiKey: 'sk-test', enabledModels: ['gpt-5.6-luna'] }],
    });
    render(<SettingsModal open onClose={() => {}} />);
    go('Models and generation');
    fireEvent.click(screen.getByRole('button', { name: /^Main models/ }));
    expect(within(screen.getByRole('list', { name: 'Selected main models' })).getByText('gpt-5.6-luna')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved selections are kept');
    expect(useSettingsStore.getState().providers[0]?.enabledModels).toEqual(['gpt-5.6-luna']);
  });
  it('shows capture state for + alt, saves the second binding, and cancels without closing', () => {
    const onClose = vi.fn();
    render(<SettingsModal open onClose={onClose} />);
    go('Shortcuts');
    fireEvent.click(screen.getByRole('button', { name: 'Add alternative for Fullscreen' }));
    expect(screen.getByText('Press keys…')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'j', altKey: true });
    expect(useSettingsStore.getState().keybindings?.fullscreen).toEqual([...KEY_ACTIONS.find((action) => action.id === 'fullscreen')!.defaultBindings, { key: 'j', alt: true }]);
    expect(screen.queryByText('Press keys…')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Add alternative/ })[0]!);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Press keys…')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
  it('uses centered saturation and brightness controls and previews real sentence wrapping', () => {
    render(<SettingsModal open onClose={() => {}} />);
    for (const name of ['Saturation', 'Brightness']) {
      expect(screen.getByRole('slider', { name })).toHaveAttribute('min', '-100');
      expect(screen.getByRole('slider', { name })).toHaveAttribute('max', '100');
    }
    fireEvent.change(screen.getByLabelText('Saturation value'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Brightness value'), { target: { value: '20' } });
    expect(useSettingsStore.getState().accentDesaturate).toBe(-30);
    expect(useSettingsStore.getState().accentDarken).toBe(-20);
    const preview = screen.getByLabelText('Node text preview');
    expect(preview.querySelectorAll('.sc-ab-sentence')).toHaveLength(2);
    expect(preview.querySelectorAll('strong')).toHaveLength(6);
    expect(within(preview).getByRole('link', { name: 'The Buddhist Catechism' })).toHaveAttribute('href', 'https://www.gutenberg.org/files/30216/30216-h/30216-h.htm');
    fireEvent.click(screen.getByRole('switch', { name: /One sentence per line/ }));
    expect(preview.querySelectorAll('.sc-ab-sentence')).toHaveLength(0);
  });
  it.each([
    ['Saturation', 'accentDesaturate'],
    ['Brightness', 'accentDarken'],
  ] as const)('keeps %s direction buttons, centered slider, number field, and reset in sync', (label, setting) => {
    render(<SettingsModal open onClose={() => {}} />);
    const positive = screen.getByRole('button', { name: `${label}: positive (+)` });
    const negative = screen.getByRole('button', { name: `${label}: negative (−)` });
    const number = screen.getByLabelText(`${label} value`);
    const slider = screen.getByRole('slider', { name: label });

    fireEvent.change(number, { target: { value: '30' } });
    expect(positive).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(negative);
    expect(number).toHaveValue(-30);
    expect(slider).toHaveValue('-30');
    expect(negative).toHaveAttribute('aria-pressed', 'true');
    expect(useSettingsStore.getState()[setting]).toBe(30);
    fireEvent.click(positive);
    expect(number).toHaveValue(30);
    expect(useSettingsStore.getState()[setting]).toBe(-30);

    fireEvent.change(slider, { target: { value: '-45' } });
    expect(number).toHaveValue(-45);
    expect(negative).toHaveAttribute('aria-pressed', 'true');
    expect(useSettingsStore.getState()[setting]).toBe(-30); // Dragging stays local until released.
    fireEvent.pointerUp(slider);
    expect(useSettingsStore.getState()[setting]).toBe(45);
    fireEvent.change(number, { target: { value: '-12' } });
    expect(negative).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(positive);
    expect(number).toHaveValue(12);
    fireEvent.change(number, { target: { value: '0' } });
    fireEvent.click(negative);
    expect(number).toHaveValue(0);
    expect(Math.abs(useSettingsStore.getState()[setting])).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: `Reset ${label} to default` }));
    expect(number).toHaveValue(-DEFAULT_SETTINGS[setting]);
    expect(slider).toHaveAttribute('min', '-100');
    expect(slider).toHaveAttribute('max', '100');
    expect(useSettingsStore.getState()[setting]).toBe(DEFAULT_SETTINGS[setting]);
  });
  it('offers a persisted default for new chats without the old model advice section', () => {
    render(<SettingsModal open onClose={() => {}} />);
    go('Models and generation');
    expect(screen.queryByText('Choosing a model')).toBeNull();
    expect(screen.queryByRole('switch', { name: /Information chunking by default/ })).toBeNull();
    go('Canvas and nodes');
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
      .toEqual(['Chat', 'Writing', 'Text selection web search']);
    expect(screen.getByRole('button', { name: 'Automatic camera movement' })).toHaveAttribute('aria-expanded', 'false');
    const chat = screen.getByRole('heading', { name: 'Chat', level: 3 }).closest('section')!;
    expect(within(chat).getByRole('textbox', { name: 'Chat instructions' })).toHaveAccessibleDescription('Applies to new and regenerated chat answers, with Information chunking on or off.');
    expect(within(chat).getByRole('switch', { name: /Information chunking by default/ })).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: /Information chunking by default/ });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().defaultChatInformationChunking).toBe(false);
    expect(screen.getByText(/one idea per sentence/)).toBeInTheDocument();
  });
  it('distinguishes reading controls and text-selection search from AI web search', () => {
    render(<SettingsModal open onClose={() => {}} />);
    const reading = screen.getByRole('heading', { name: 'Reading', level: 3 }).closest('section')!;
    expect(reading).toHaveTextContent('Used for node titles and text, including chats.');
    const paragraphs = within(reading).getByRole('group', { name: 'Paragraph layout' });
    expect(paragraphs).toHaveAccessibleDescription('For encyclopedic and explain nodes.');
    expect(within(reading).getAllByRole('heading', { level: 4 }).slice(0, 2).map(heading => heading.textContent))
      .toEqual(['Font', 'Paragraph layout']);
    expect(within(paragraphs).getByRole('switch', { name: /One sentence per line/ })).toBeInTheDocument();
    expect(paragraphs).toHaveTextContent('For encyclopedic node introductions and explain nodes. Show the text’s existing line breaks');
    expect(paragraphs).toHaveTextContent('In the editor, you control where lines break.');
    expect(within(paragraphs).getByRole('switch', { name: /Justify the opening paragraph/ })).toBeInTheDocument();
    expect(reading).not.toHaveTextContent('Paragraph layout applies to');
    expect(reading).not.toHaveTextContent('Menus, buttons, and interactive content');
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
      .toEqual(['Color theme', 'Reading', 'Canvas accents', 'Group colors']);
    go('Canvas and nodes');
    expect(screen.queryByRole('heading', { name: 'Reading', level: 3 })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Group colors', level: 3 })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Text selection web search' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Web search' })).toBeNull();
    expect(screen.getByText('DO NOT TOUCH', { exact: true })).toBeInTheDocument();
  });
  it('groups model automation and token limits in collapsed sections with token limits last', () => {
    render(<SettingsModal open onClose={() => {}} />);
    go('Models and generation');
    const names = ['Automatic model updates', 'Automatic enrichment', 'Generation token limits'];
    expect(screen.getAllByRole('button').filter(button => names.includes(button.getAttribute('aria-label') ?? ''))
      .map(button => button.getAttribute('aria-label'))).toEqual(names);
    for (const name of names) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('slider', { name: 'Main generations' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Generation token limits' }));
    const limit = screen.getByRole('slider', { name: 'Main generations' });
    fireEvent.change(limit, { target: { value: '24000' } });
    fireEvent.keyUp(limit, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Generation token limits' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generation token limits' }));
    expect(screen.getByRole('slider', { name: 'Main generations' })).toHaveValue('24000');
    go('Developer');
    expect(screen.queryByRole('button', { name: 'Generation token limits' })).toBeNull();
  });
});
