import type { InteractiveBuild } from '@/store/types';

/** Legacy exports have only the error text; new builds store this explicitly. */
export function interactiveNeedsVerification(build?: InteractiveBuild): boolean {
  return !!build && (build.verificationPending ?? /^(?:Alternate-theme screenshot capture failed|Screenshot capture failed|Visual review could not complete):/i.test(build.error ?? ''));
}

export function interactivePendingIssues(build?: InteractiveBuild): string[] {
  if (!build) return [];
  if (build.pendingIssues) return build.pendingIssues;
  const review = [...build.steps].reverse().find(step => step.state === 'failed'
    && step.label === 'Reviewing screenshots, behavior and request coverage' && step.detail
    && !step.detail.startsWith('Visual review could not complete'));
  return review?.detail ? review.detail.split('\n').filter(Boolean) : [];
}
