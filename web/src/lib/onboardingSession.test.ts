import { beforeEach, describe, expect, it } from 'vitest';
import { clearOnboardingSession, readOnboardingSession, saveOnboardingSession } from './onboardingSession';
beforeEach(() => sessionStorage.clear());
describe('setup resume state', () => {
  it('preserves restoration across an authorization redirect without storing credentials', () => {
    saveOnboardingSession('restore', 'connect', { restoreSync: true });
    saveOnboardingSession('restore', 'review');
    expect(readOnboardingSession()).toMatchObject({ path: 'restore', step: 'review', restoreSync: true });
  });
  it('does not carry restoration flags into a different setup path', () => {
    saveOnboardingSession('restore', 'connect', { restoreSync: true, syncPicker: true });
    saveOnboardingSession('quick', 'connect');
    expect(readOnboardingSession()).toMatchObject({ restoreSync: false, syncPicker: false });
  });
  it('ignores malformed state and clears a finished setup', () => {
    sessionStorage.setItem('scatter.onboarding', '{'); expect(readOnboardingSession()).toBeNull();
    sessionStorage.setItem('scatter.onboarding', '{"path":"invalid","step":"review"}'); expect(readOnboardingSession()).toBeNull();
    saveOnboardingSession('custom', 'review'); clearOnboardingSession(); expect(readOnboardingSession()).toBeNull();
  });
});
