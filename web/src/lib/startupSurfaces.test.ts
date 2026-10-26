import { describe, expect, it } from 'vitest';
import {
  resolveStartupSurfaces,
  shouldHoldRestorationForProject,
  type StartupSurfaceInput,
} from './startupSurfaces';

const READY: StartupSurfaceInput = {
  settingsHydrated: true,
  projectBootstrapStatus: 'ready',
  forceWelcomeA: false,
  providerConnected: true,
  hasActiveModel: true,
  pickerOpen: false,
  hasProject: true,
  projectHasNodes: true,
};

describe('resolveStartupSurfaces', () => {
  it('preserves the topic picker while settings temporarily clears models or providers', () => {
    const input = { ...READY, pickerOpen: true, providerConnected: false, hasActiveModel: false,
      editingPickerSettings: true };
    expect(resolveStartupSurfaces(input)).toMatchObject({ showWelcomeA: false, showWelcomeB: true, showCanvas: true });
    expect(resolveStartupSurfaces({ ...input, projectHasNodes: false, pickerOpen: false }))
      .toMatchObject({ showWelcomeA: false, showWelcomeB: true });
    expect(resolveStartupSurfaces({ ...input, providerConnected: true, hasActiveModel: true, editingPickerSettings: false }))
      .toMatchObject({ showWelcomeA: false, showWelcomeB: true });
    expect(resolveStartupSurfaces({ ...input, forceWelcomeA: true })).toMatchObject({ showWelcomeA: true, showWelcomeB: false });
    expect(resolveStartupSurfaces({ ...input, editingPickerSettings: false })).toMatchObject({ showWelcomeA: true });
  });
  it('shows only restoration until both settings and projects are resolved', () => {
    expect(resolveStartupSurfaces({ ...READY, projectBootstrapStatus: 'pending' })).toEqual({
      showRestoration: true,
      showRestorationError: false,
      showWelcomeA: false,
      showWelcomeB: false,
      showCanvas: false,
    });
    expect(resolveStartupSurfaces({ ...READY, settingsHydrated: false })).toMatchObject({
      showRestoration: true,
      showWelcomeA: false,
      showWelcomeB: false,
      showCanvas: false,
    });
  });

  it('opens a restored populated project immediately', () => {
    expect(resolveStartupSurfaces(READY)).toMatchObject({
      showRestoration: false,
      showWelcomeA: false,
      showWelcomeB: false,
      showCanvas: true,
    });
  });

  it('shows the topic picker only after an empty project is confirmed', () => {
    expect(resolveStartupSurfaces({ ...READY, projectHasNodes: false })).toMatchObject({
      showRestoration: false,
      showWelcomeB: true,
      showCanvas: true,
    });
  });

  it('keeps all ordinary surfaces hidden after a restoration error', () => {
    expect(resolveStartupSurfaces({ ...READY, projectBootstrapStatus: 'error' })).toEqual({
      showRestoration: false,
      showRestorationError: true,
      showWelcomeA: false,
      showWelcomeB: false,
      showCanvas: false,
    });
  });

  it('holds one full showcase cycle for any restored project canvas, including an empty topic draft', () => {
    expect(shouldHoldRestorationForProject({
      showCanvas: true,
      startupCanvasReady: true,
      minimumCycleComplete: false,
    })).toBe(true);
    expect(shouldHoldRestorationForProject({
      showCanvas: true,
      startupCanvasReady: true,
      minimumCycleComplete: true,
    })).toBe(false);
    expect(shouldHoldRestorationForProject({
      showCanvas: false,
      startupCanvasReady: false,
      minimumCycleComplete: false,
    })).toBe(false);
    expect(shouldHoldRestorationForProject({
      showCanvas: true,
      startupCanvasReady: false,
      minimumCycleComplete: false,
    })).toBe(true);
  });
});
