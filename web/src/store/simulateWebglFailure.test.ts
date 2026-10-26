import { describe, it, expect, afterEach } from 'vitest';
import { useSettingsStore } from './useSettingsStore';

afterEach(() => useSettingsStore.setState({ simulateWebglFailure: false }));

describe('simulateWebglFailure dev flag (ephemeral)', () => {
  it('defaults to false', () => {
    expect(useSettingsStore.getState().simulateWebglFailure).toBe(false);
  });

  it('toggles via setSimulateWebglFailure', () => {
    useSettingsStore.getState().setSimulateWebglFailure(true);
    expect(useSettingsStore.getState().simulateWebglFailure).toBe(true);
    useSettingsStore.getState().setSimulateWebglFailure(false);
    expect(useSettingsStore.getState().simulateWebglFailure).toBe(false);
  });
});
