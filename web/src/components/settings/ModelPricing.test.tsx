import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ModelMetaBadges } from '../ModelMetaBadges';
import { SelectedModelDetails } from './SelectedModelDetails';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';

beforeEach(() => {
  useModelCatalogStore.getState().clear();
  useSettingsStore.setState({ openRouterRouting: 'fast-start' });
});

describe('model pricing labels', () => {
  it.each(['openai', 'openrouter'] as const)('does not prefix %s prices with an estimation sign', (preset) => {
    useModelCatalogStore.getState().setCatalog('provider', [{
      id: 'test-model', pricing: { inputPerM: 1, outputPerM: 12.4 },
    }]);
    const { container } = render(<ModelMetaBadges providerId="provider" preset={preset} model="test-model" />);
    expect(screen.getByText('$12/M')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('~');
  });

  it('shows explicitly labeled properties next to a selected model', () => {
    useModelCatalogStore.getState().setCatalog('provider', [{ id: 'test',
      pricing: { inputPerM: 0.2, outputPerM: 1 }, contextLength: 200_000,
      caps: { reasoning: true, vision: true, tools: true },
    }]);
    const { container } = render(<SelectedModelDetails providerId="provider" preset="openrouter" model="test" />);
    expect(screen.getByText('Cost:')).toBeInTheDocument();
    expect(screen.getByText('Context length:')).toBeInTheDocument();
    expect(screen.getByText('200k tokens')).toBeInTheDocument();
    expect(screen.getByText('Reasoning model')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('~');
  });
});
