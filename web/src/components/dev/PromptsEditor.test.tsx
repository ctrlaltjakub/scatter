import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptsEditor } from './PromptsEditor';
import { PROMPT_CATALOG, PROMPT_KEYS } from '@/lib/promptCatalog';
import { DEFAULT_PROMPTS } from '@/lib/promptDefaults';
import { configuredPrompt } from '@/lib/configuredPrompt';
import { chatSystemPrompt } from '@/lib/chat/context';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => undefined), loadSettings: vi.fn() }));
beforeEach(() => useSettingsStore.setState({ ...DEFAULT_SETTINGS, customPrompts: undefined }));

describe('complete prompt library', () => {
  it('lists every catalog prompt, with no hidden whitelist', () => {
    render(<PromptsEditor />);
    const labels = screen.getAllByRole('button').map(button => button.getAttribute('aria-label'));
    for (const key of PROMPT_KEYS) expect(labels).toContain(PROMPT_CATALOG[key].label);
  });

  it('renders emphasis in every prompt description without exposing formatting markers', () => {
    render(<PromptsEditor />);
    const buttons = new Map(screen.getAllByRole('button').map(button => [button.getAttribute('aria-label'), button]));
    for (const key of PROMPT_KEYS) {
      const button = buttons.get(PROMPT_CATALOG[key].label)!;
      const description = document.getElementById(button.getAttribute('aria-describedby')!);
      expect(description?.querySelector('strong')).toBeTruthy();
      expect(description?.textContent).not.toContain('**');
    }
  });

  it.each(PROMPT_KEYS)('edits %s through its visible settings control', (key) => {
    render(<PromptsEditor />);
    const label = PROMPT_CATALOG[key].label;
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search prompts' }), { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: label }));
    const input = screen.getByRole('textbox', { name: label });
    expect(input).toHaveValue(DEFAULT_PROMPTS[key]);
    fireEvent.change(input, { target: { value: `Edited ${key}` } });
    expect(configuredPrompt(key)).toBe(`Edited ${key}`);
    expect(screen.getByRole('button', { name: `${label} • edited` })).toBeInTheDocument();
  });

  it('searches descriptions as well as titles, and edited chat instructions reach the next request', () => {
    render(<PromptsEditor />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search prompts' }), { target: { value: 'core behavior for conversations' } });
    fireEvent.click(screen.getByRole('button', { name: 'Chat: system' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat: system' }), { target: { value: 'Use patient, concrete explanations.' } });
    expect(chatSystemPrompt(false, '', false)).toContain('Use patient, concrete explanations.');
    fireEvent.click(screen.getByRole('button', { name: 'Reset this field' }));
    expect(chatSystemPrompt(false, '', false)).toContain(DEFAULT_PROMPTS.chatBase);
  });

  it('copies effective values and resets fields without saved versions', async () => {
    const clipboard = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
    const custom = { chatBase: 'Custom chat', termPreviewSystem: 'Custom previews', factCheckContract: 'Custom checking' };
    useSettingsStore.setState({ customPrompts: custom });
    render(<PromptsEditor />);
    expect(screen.queryByRole('button', { name: 'Save version' })).toBeNull();
    expect(screen.queryByLabelText('Prompt version label')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy all prompts' }));
    expect(JSON.parse(clipboard.mock.calls[0]![0])).toEqual({ ...DEFAULT_PROMPTS, ...custom });
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }));
    expect(useSettingsStore.getState().customPrompts).toBeUndefined();
  });
});
