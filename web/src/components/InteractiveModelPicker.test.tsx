import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InteractiveModelPicker } from './InteractiveModelPicker';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';

describe('InteractiveModelPicker', () => {
  beforeEach(() => {
    useModelCatalogStore.getState().clear();
    useSettingsStore.setState({
      modelCompatibilityOverrides: {},
      providers: [{
        id: 'openai', preset: 'openai', apiKey: 'sk-test',
        enabledModels: ['gpt-5.6-terra', 'gpt-image-2'],
      }],
      activeModelRef: { providerId: 'openai', model: 'gpt-5' },
      interactiveModelRef: undefined,
    });
    useModelCatalogStore.getState().setCatalog('openai', [
      { id: 'gpt-5.6-terra', caps: { textOutput: true } },
      { id: 'gpt-5-mini', caps: { textOutput: true } },
      { id: 'gpt-image-2', caps: { textOutput: false } },
    ]);
  });

  it('defaults to the main text model and excludes image-only models', async () => {
    render(<InteractiveModelPicker />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Use main text model — gpt-5' }))
      .toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText('gpt-5-mini')).toBeTruthy();
    expect(screen.queryByText('gpt-image-2')).toBeNull();
  });

  it('fuzzy-filters the provider catalog and stores any selected text model', async () => {
    render(<InteractiveModelPicker />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter interactive explanation models' }), {
      target: { value: 'mini' },
    });
    await waitFor(() => expect(screen.getByText('gpt-5-mini')).toBeTruthy());
    expect(screen.queryByText('gpt-5.6-terra')).toBeNull();
    fireEvent.click(screen.getByText('gpt-5-mini').closest('button')!);
    expect(useSettingsStore.getState().interactiveModelRef).toEqual({
      providerId: 'openai', model: 'gpt-5-mini',
    });
  });

  it('shows normally excluded models only with the interactive-role override', async () => {
    render(<InteractiveModelPicker />);
    expect(screen.queryByText('gpt-image-2')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /Show all models/ }));
    fireEvent.click(await screen.findByRole('option', { name: /^gpt-image-2/ }));
    expect(useSettingsStore.getState().interactiveModelRef?.model).toBe('gpt-image-2');
    expect(useSettingsStore.getState().modelCompatibilityOverrides).toEqual({ interactive: true });
    fireEvent.click(screen.getByRole('switch', { name: /Show all models/ }));
    expect(screen.queryByRole('option', { name: /^gpt-image-2/ })).not.toBeInTheDocument();
    expect(useSettingsStore.getState().interactiveModelRef?.model).toBe('gpt-image-2');
  });

  it('does not surface unrelated models for a specific production-like query', async () => {
    useSettingsStore.setState({
      providers: [{
        id: 'openrouter', preset: 'openrouter', apiKey: 'sk-test', enabledModels: [],
      }],
      activeModelRef: { providerId: 'openrouter', model: 'google/gemini-3.1-pro-preview' },
    });
    useModelCatalogStore.getState().setCatalog('openrouter', [
      { id: 'google/gemini-3.1-pro-preview', caps: { textOutput: true, vision: true } },
      { id: 'openai/gpt-5.6-terra', caps: { textOutput: true, vision: true } },
      { id: 'anthropic/claude-opus-4.8', caps: { textOutput: true, vision: true } },
    ]);
    render(<InteractiveModelPicker />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter interactive explanation models' }), {
      target: { value: 'openai terra' },
    });
    await waitFor(() => expect(screen.getByText('openai/gpt-5.6-terra')).toBeTruthy());
    expect(screen.queryByText('google/gemini-3.1-pro-preview')).toBeNull();
    expect(screen.queryByText('anthropic/claude-opus-4.8')).toBeNull();
  });

  it('describes binary reasoning as On instead of a nonexistent High level', async () => {
    useSettingsStore.setState({
      providers: [{ id: 'local', preset: 'lm-studio', apiKey: 'local-test', enabledModels: ['qwen'] }],
      activeModelRef: { providerId: 'local', model: 'qwen' },
      interactiveReasoningEffort: 'high',
    });
    useModelCatalogStore.getState().setCatalog('local', [{ id: 'qwen', caps: { textOutput: true, reasoning: true },
      reasoning: { mode: 'toggle', supportedEfforts: ['off', 'high'] } }]);
    render(<InteractiveModelPicker settingsLayout />);
    expect(await screen.findByRole('slider', { name: 'Reasoning effort' })).toHaveAttribute('aria-valuetext', 'On');
    expect(screen.getByText('On', { selector: 'strong' }).parentElement).toHaveTextContent('On is selected by default.');
    expect(screen.queryByText('High', { selector: 'strong' })).not.toBeInTheDocument();
  });
  it('requires vision in the ordinary list but preserves the explicit compatibility override', async () => {
    useSettingsStore.setState({ providers: [{ id: 'local', preset: 'custom', apiKey: 'local', enabledModels: [] }] });
    useModelCatalogStore.getState().setCatalog('local', [
      { id: 'vision-code', caps: { textOutput: true, vision: true } },
      { id: 'text-code', caps: { textOutput: true, tools: true, vision: false } },
      { id: 'unknown-code', caps: { textOutput: true } },
    ]);
    render(<InteractiveModelPicker />);
    expect(await screen.findByText('vision-code')).toBeVisible();
    expect(screen.queryByText('text-code')).toBeNull();
    expect(screen.queryByText('unknown-code')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /Show all models/ }));
    expect(await screen.findByText('text-code')).toBeVisible();
    expect(screen.getByText('unknown-code')).toBeVisible();
  });
});
