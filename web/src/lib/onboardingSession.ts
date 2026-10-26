export type OnboardingPath = 'quick' | 'custom' | 'restore';
export type OnboardingStep = 'choose' | 'connect' | 'review' | 'confirm';
const KEY = 'scatter.onboarding';
export interface OnboardingSession {
  path: OnboardingPath;
  step: OnboardingStep;
  restoreSync?: boolean;
  syncPicker?: boolean;
  recommendationsApplied?: boolean;
}

export function readOnboardingSession(): OnboardingSession | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return value && ['quick', 'custom', 'restore'].includes(value.path)
      && ['choose', 'connect', 'review', 'confirm'].includes(value.step) ? {
        path: value.path, step: value.step,
        restoreSync: value.restoreSync === true,
        syncPicker: value.syncPicker === true,
        recommendationsApplied: value.recommendationsApplied === true,
      } : null;
  } catch { return null; }
}
export function saveOnboardingSession(path: OnboardingPath, step: OnboardingStep, extra: Partial<Omit<OnboardingSession, 'path' | 'step'>> = {}) {
  const saved = readOnboardingSession();
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...(saved?.path === path ? saved : {}), path, step, ...extra })); } catch { /* setup can still run without reload */ }
}
export function clearOnboardingSession() {
  try { sessionStorage.removeItem(KEY); } catch { /* navigation only */ }
}
