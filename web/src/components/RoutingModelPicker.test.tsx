import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RoutingModelPicker } from './RoutingModelPicker';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';

beforeEach(() => {
  useSettingsStore.setState({
    providers: [{
      id: 'router',
      preset: 'openrouter',
      apiKey: 'key',
      enabledModels: ['z-model', 'a-model', 'text-only'],
    }],
    activeModelRef: { providerId: 'router', model: 'z-model' },
    secondaryUseSameModel: false,
    secondaryModelRef: { providerId: 'router', model: 'z-model' },
  });
  useModelCatalogStore.getState().clear();
  useModelCatalogStore.getState().setCatalog('router', [
    { id: 'z-model', caps: { vision: true, textOutput: true } },
    { id: 'a-model', caps: { vision: true, textOutput: true } },
    { id: 'text-only', caps: { vision: false, textOutput: true } },
  ]);
});

describe('RoutingModelPicker', () => {
  it('defaults to the generation model and exposes the dedicated catalog alphabetically', () => {
    render(<RoutingModelPicker />);
    const options = screen.getAllByRole('option')
      .map((option) => option.textContent ?? '');
    expect(screen.getByRole('option', { name: /z-model/ })).toHaveAttribute('aria-selected', 'true');
    expect(options.findIndex((value) => value.includes('a-model')))
      .toBeLessThan(options.findIndex((value) => value.includes('z-model')));
    expect(options.some((value) => value.includes('text-only'))).toBe(false);
  });

  it('stores the dedicated routing choice', () => {
    render(<RoutingModelPicker />);
    fireEvent.click(screen.getByRole('option', { name: /a-model/ }));
    expect(useSettingsStore.getState().secondaryModelRef).toEqual({
      providerId: 'router',
      model: 'a-model',
    });
    expect(useSettingsStore.getState().secondaryUseSameModel).toBe(false);
  });

  it('does not offer non-vision models for secondary work', () => {
    useSettingsStore.setState({
      activeModelRef: { providerId: 'router', model: 'text-only' },
      secondaryModelRef: undefined,
    });
    render(<RoutingModelPicker />);
    expect(screen.queryByRole('option', { name: /text-only/ })).toBeNull();
  });
});
