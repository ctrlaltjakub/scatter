import type { ProjectBootstrapStatus } from '@/store/persist';

export interface StartupSurfaceInput {
  settingsHydrated: boolean;
  projectBootstrapStatus: ProjectBootstrapStatus;
  forceWelcomeA: boolean;
  providerConnected: boolean;
  hasActiveModel: boolean;
  pickerOpen: boolean;
  hasProject: boolean;
  projectHasNodes: boolean;
  /** Do not discard a topic draft while its settings overlay changes model choices. */
  editingPickerSettings?: boolean;
}

export interface StartupSurfaces {
  showRestoration: boolean;
  showRestorationError: boolean;
  showWelcomeA: boolean;
  showWelcomeB: boolean;
  showCanvas: boolean;
}

export interface RestorationProjectHoldInput {
  showCanvas: boolean;
  startupCanvasReady: boolean;
  minimumCycleComplete: boolean;
}

/** Keep the showcase visible for any restored project canvas—including an
 * empty source-draft project whose topic picker will appear after the cycle. */
export function shouldHoldRestorationForProject({
  showCanvas,
  startupCanvasReady,
  minimumCycleComplete,
}: RestorationProjectHoldInput): boolean {
  return showCanvas
    && (!startupCanvasReady || !minimumCycleComplete);
}

/**
 * Resolve the mutually dependent startup surfaces without ever treating an
 * unresolved project read as a confirmed empty workspace.
 */
export function resolveStartupSurfaces(input: StartupSurfaceInput): StartupSurfaces {
  if (input.projectBootstrapStatus === 'error') {
    return {
      showRestoration: false,
      showRestorationError: true,
      showWelcomeA: false,
      showWelcomeB: false,
      showCanvas: false,
    };
  }

  if (!input.settingsHydrated || input.projectBootstrapStatus === 'pending') {
    return {
      showRestoration: true,
      showRestorationError: false,
      showWelcomeA: false,
      showWelcomeB: false,
      showCanvas: false,
    };
  }

  const showWelcomeA = input.forceWelcomeA
    || (!input.editingPickerSettings && (!input.providerConnected || !input.hasActiveModel));
  const showCanvas = !showWelcomeA && input.hasProject;
  return {
    showRestoration: false,
    showRestorationError: false,
    showWelcomeA,
    showWelcomeB: !showWelcomeA
      && (input.pickerOpen || !input.hasProject || !input.projectHasNodes),
    showCanvas,
  };
}
