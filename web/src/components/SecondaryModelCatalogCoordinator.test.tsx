import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecondaryModelCatalogCoordinator } from './SecondaryModelCatalogCoordinator';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(async () => [{
    id: 'vision-model',
    caps: { vision: true, textOutput: true },
  }]),
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...actual,
    getAdapter: () => ({ listModels: mocks.listModels }),
  };
});

describe('SecondaryModelCatalogCoordinator', () => {
  beforeEach(() => {
    mocks.listModels.mockClear();
    useModelCatalogStore.getState().clear();
    useSettingsStore.setState({
      hydrated: true,
      providers: [{
        id: 'router',
        preset: 'openrouter',
        apiKey: 'key',
        enabledModels: ['vision-model'],
      }],
      activeModelRef: { providerId: 'router', model: 'main-model' },
      secondaryModelRef: { providerId: 'router', model: 'vision-model' },
      secondaryUseSameModel: false,
    });
  });

  it('restores saved secondary-model vision metadata without opening a picker', async () => {
    render(<SecondaryModelCatalogCoordinator />);

    await waitFor(() => {
      expect(useModelCatalogStore.getState().getModel('router', 'vision-model'))
        .toMatchObject({ caps: { vision: true, textOutput: true } });
    });
    expect(mocks.listModels).toHaveBeenCalledTimes(1);
  });
});
