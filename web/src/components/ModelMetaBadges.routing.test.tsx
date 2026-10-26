import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import { textEndpointKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { ModelMetaBadges } from './ModelMetaBadges';

afterEach(() => {
  act(() => {
    useModelCatalogStore.getState().clear();
    useSettingsStore.setState({ openRouterRouting: 'fast-start' });
  });
});

describe('ModelMetaBadges OpenRouter route price', () => {
  it('updates immediately when routing changes', () => {
    act(() => {
      useSettingsStore.setState({ openRouterRouting: 'fast-start' });
      useModelCatalogStore.setState({
        catalog: { p: [{ id: 'm', pricing: { outputPerM: 5 } }] },
        endpoints: {
          [textEndpointKey('p', 'm')]: [
            {
              providerName: 'Cheap', tag: 'cheap', status: 0, latencyP50Ms: 3000,
              pricing: { inputPerM: 0.2, outputPerM: 1.2 },
            },
            {
              providerName: 'Fast', tag: 'amazon-bedrock/us-east-1', status: 0, latencyP50Ms: 1000,
              pricing: { inputPerM: 0.22, outputPerM: 1.32 },
            },
          ],
        },
      });
    });
    render(<ModelMetaBadges providerId="p" preset="openrouter" model="m" />);
    expect(screen.getByText('$1.32/M')).toBeInTheDocument();

    act(() => useSettingsStore.setState({ openRouterRouting: 'lowest-cost' }));
    expect(screen.getByText('$1.20/M')).toBeInTheDocument();
  });
});
