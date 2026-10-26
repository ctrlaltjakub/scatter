import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ImageModelPicker } from './ImageModelPicker';
import { DEFAULT_SETTINGS } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';

vi.mock('@/opfs/settingsIO', () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(async () => undefined),
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  useImageModelCatalogStore.getState().clear();
  useModelCatalogStore.getState().clear();
  useSettingsStore.setState({
    ...DEFAULT_SETTINGS,
    hydrated: true,
    providers: [{ id: 'openai-1', preset: 'openai', apiKey: 'key', enabledModels: ['gpt-5.4'] }],
    activeModelRef: { providerId: 'openai-1', model: 'gpt-5.4' },
    imageModelRef: undefined,
  });
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: [
      { id: 'gpt-5.4' },
      { id: 'gpt-image-2' },
      { id: 'gpt-image-1' },
      { id: 'dall-e-3' },
    ] }),
  })) as unknown as typeof fetch;
});

afterEach(() => { globalThis.fetch = originalFetch; });

describe('ImageModelPicker', () => {
  it('exposes the full supported-provider catalog with the override and preserves the choice when filtering returns', async () => {
    render(<ImageModelPicker settingsLayout />);
    await screen.findByRole('option', { name: 'gpt-image-2' });
    expect(screen.queryByRole('option', { name: 'dall-e-3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'gpt-5.4' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Show all models/ }));
    expect(await screen.findByRole('option', { name: 'gpt-5.4' })).toBeEnabled();
    fireEvent.click(screen.getByRole('option', { name: 'dall-e-3' }));
    expect(useSettingsStore.getState().imageModelRef?.model).toBe('dall-e-3');
    expect(useSettingsStore.getState().modelCompatibilityOverrides).toEqual({ image: true });
    fireEvent.click(screen.getByRole('switch', { name: /Show all models/ }));
    expect(screen.queryByRole('option', { name: 'dall-e-3' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Selected image model')).toHaveTextContent('dall-e-3');
  });

  it('keeps the override accessible when no model has confirmed editing support', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'dall-e-3' }] }) })) as unknown as typeof fetch;
    render(<ImageModelPicker />);
    await screen.findByText('No models with confirmed image editing support are available for these providers.');
    fireEvent.click(screen.getByRole('switch', { name: /Show all models/ }));
    expect(await screen.findByRole('option', { name: 'dall-e-3' })).toBeEnabled();
  });
  it('preserves a legacy generation-only selection and explains how to replace it', async () => {
    useSettingsStore.setState({ imageModelRef: { providerId: 'openai-1', model: 'dall-e-3' } });
    render(<ImageModelPicker settingsLayout />);
    expect(await screen.findByRole('alert')).toHaveTextContent('does not have confirmed editing support');
    expect(useSettingsStore.getState().imageModelRef?.model).toBe('dall-e-3');
    expect(screen.queryByRole('option', { name: 'dall-e-3' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('option', { name: 'gpt-image-1' }));
    expect(useSettingsStore.getState().imageModelRef?.model).toBe('gpt-image-1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('reports an empty editing catalog without selecting an unknown capability model', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'dall-e-3' }] }) })) as unknown as typeof fetch;
    render(<ImageModelPicker />);
    expect(await screen.findByText('No models with confirmed image editing support are available for these providers.')).toBeInTheDocument();
    expect(useSettingsStore.getState().imageModelRef).toBeUndefined();
  });
  it('shows saved known model controls immediately while the catalog request is pending', () => {
    useSettingsStore.setState({ imageModelRef: { providerId: 'openai-1', model: 'gpt-image-2' } });
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<ImageModelPicker settingsLayout />);
    expect(screen.getByLabelText('Size')).toHaveValue('1536x1024');
  });
  it('keeps image generation off until explicitly choosing a model, then uses high landscape defaults', async () => {
    render(<ImageModelPicker />);
    const option = await screen.findByRole('option', { name: 'gpt-image-2' });
    expect(useSettingsStore.getState().imageModelRef).toBeUndefined();
    expect(screen.getByRole('option', { name: 'None' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('Quality')).not.toBeInTheDocument();
    fireEvent.click(option);
    expect(useSettingsStore.getState().imageModelRef).toEqual({
      providerId: 'openai-1', model: 'gpt-image-2',
    });
    expect(screen.getByRole('option', { name: 'gpt-image-2' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Quality')).toHaveValue('high');
    expect(screen.getByLabelText('Size')).toHaveValue('1536x1024');
    expect(screen.getAllByText('Image editing')).not.toHaveLength(0);
    expect(screen.getAllByText('from $0.005/image')).not.toHaveLength(0);
    expect(screen.getByText('Estimated output cost: $0.165/image')).toBeInTheDocument();
    expect(screen.getByText(/MP means one million pixels/)).not.toHaveTextContent('~');
    expect(screen.getByText(/not \$30 per image/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'low' } });
    expect(screen.getByText('Estimated output cost: $0.005/image')).toBeInTheDocument();
  });

  it('keeps common controls upfront and provider-supported controls behind Advanced options', async () => {
    render(<ImageModelPicker />);
    fireEvent.click(await screen.findByRole('option', { name: 'gpt-image-2' }));
    expect(screen.getByLabelText('Quality')).toBeInTheDocument();
    expect(screen.getByLabelText('Size')).toBeInTheDocument();
    expect(screen.queryByLabelText('Format')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }));
    expect(screen.getByLabelText('Format')).toHaveValue('png');
    expect(screen.getByLabelText('Background')).toHaveValue('auto');
    expect(screen.getByLabelText('Moderation')).toHaveValue('auto');
    expect(screen.getByLabelText('Input fidelity')).toHaveValue('high');
    expect(screen.queryByLabelText('Compression')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'jpeg' } });
    expect(screen.getByLabelText('Compression')).toBeInTheDocument();
  });

  it('uses exact Size as an explicit advanced override when shape controls are available', async () => {
    useSettingsStore.setState({
      providers: [{ id: 'or-1', preset: 'openrouter', apiKey: 'key', enabledModels: [] }],
      imageModelRef: { providerId: 'or-1', model: 'openai/gpt-image-2' },
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{
        id: 'openai/gpt-image-2',
        architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: {
          quality: { type: 'enum', values: ['auto', 'high'] },
          resolution: { type: 'enum', values: ['1K', '2K', '4K'] },
          aspect_ratio: { type: 'enum', values: ['1:1', '3:2'] },
          size: { type: 'enum', values: ['1024x1024', '1536x1024', 'custom'] },
        },
      }] }),
    })) as unknown as typeof fetch;

    render(<ImageModelPicker />);
    await screen.findByRole('option', { name: 'openai/gpt-image-2' });
    expect(screen.getByLabelText('Quality')).toBeInTheDocument();
    expect(screen.getByLabelText('Resolution')).toBeInTheDocument();
    expect(screen.getByLabelText('Aspect ratio')).toBeInTheDocument();
    expect(screen.queryByLabelText('Size')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }));
    expect(screen.getByLabelText('Size')).toHaveValue('__shape__');
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: '1536x1024' } });
    expect(useSettingsStore.getState().imageGenerationSettings).toMatchObject({
      useExactSize: true, size: '1536x1024',
    });
  });

  it('excludes generation-only models even when searched by name', async () => {
    render(<ImageModelPicker />);
    await screen.findByRole('option', { name: 'gpt-image-2' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter image models' }), {
      target: { value: 'dal e 3' },
    });
    const list = screen.getByRole('listbox', { name: 'Image model' });
    expect(within(list).queryByRole('option', { name: 'dall-e-3' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('option', { name: 'gpt-image-2' })).not.toBeInTheDocument();
    expect(useSettingsStore.getState().imageModelRef).toBeUndefined();
  });

  it('offers an explicit None choice and does not auto-select a model afterward', async () => {
    render(<ImageModelPicker />);
    await screen.findByRole('option', { name: 'gpt-image-2' });

    fireEvent.click(screen.getByRole('option', { name: 'None' }));

    expect(useSettingsStore.getState().imageModelRef).toBeNull();
    expect(screen.getByRole('option', { name: 'None' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(useSettingsStore.getState().imageModelRef).toBeNull());
    expect(screen.queryByLabelText('Quality')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Size')).not.toBeInTheDocument();
  });

  it('keeps None selectable even when no image provider is connected', () => {
    useSettingsStore.setState({ providers: [], imageModelRef: undefined });
    render(<ImageModelPicker />);
    fireEvent.click(screen.getByRole('option', { name: 'None' }));
    expect(useSettingsStore.getState().imageModelRef).toBeNull();
  });

  it('uses the same field-row, filter, and model-list structure as the provider model picker', async () => {
    const { container } = render(<ImageModelPicker providerId="openai-1" />);
    await screen.findByRole('option', { name: 'gpt-image-2' });
    expect(screen.getByText('Image model')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Filter…')).toBeInTheDocument();
    expect(container.querySelector('.field-row.sc-image-model-picker-row')).toBeInTheDocument();
    expect(container.querySelector('.sc-image-model-picker--embedded .sc-model-list')).toBeInTheDocument();
  });
});
