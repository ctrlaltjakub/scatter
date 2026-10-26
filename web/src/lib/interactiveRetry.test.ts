import { describe, expect, it } from 'vitest';
import { interactiveNeedsVerification, interactivePendingIssues } from './interactiveRetry';
import type { InteractiveBuild } from '@/store/types';

const build: InteractiveBuild = { request: 'Counter', state: 'failed', steps: [] };
describe('persisted interactive repair evidence', () => {
  it('recovers prior visual findings from old exports instead of feeding a capture failure to the coder', () => {
    const previous: InteractiveBuild = { ...build, error: 'Alternate-theme screenshot capture failed: No image', steps: [
      { id: 1, state: 'failed', label: 'Reviewing screenshots, behavior and request coverage', detail: 'Reset is broken.\nThe count is wrong.' },
      { id: 2, state: 'failed', label: 'Checking alternate theme and capturing screenshot', detail: 'No image' },
    ] };
    expect(interactiveNeedsVerification(previous)).toBe(true);
    expect(interactivePendingIssues(previous)).toEqual(['Reset is broken.', 'The count is wrong.']);
  });
  it('does not revive old failures after a full successful review', () => {
    expect(interactivePendingIssues({ ...build, pendingIssues: [], steps: [
      { id: 1, state: 'failed', label: 'Reviewing screenshots, behavior and request coverage', detail: 'Old issue' },
    ] })).toEqual([]);
    expect(interactiveNeedsVerification({ ...build, verificationPending: false, error: 'Screenshot capture failed: old error' })).toBe(false);
  });
});
