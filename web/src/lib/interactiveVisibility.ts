import type { InteractiveCheck } from './interactiveTests';

export interface InteractiveProbeLifecycle {
  onVisibilityWait?: (waiting: boolean) => void;
  /** Production recovery only. Explicit capability tests stay single-attempt. */
  retryCapture?: boolean;
  onCaptureRetry?: () => void;
}

const stopped = () => new DOMException('Stopped', 'AbortError');

function waitForVisible(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(stopped());
  if (document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener('visibilitychange', visible);
      signal.removeEventListener('abort', abort);
    };
    const visible = () => {
      if (document.visibilityState === 'hidden') return;
      cleanup(); resolve();
    };
    const abort = () => { cleanup(); reject(stopped()); };
    document.addEventListener('visibilitychange', visible);
    signal.addEventListener('abort', abort, { once: true });
    visible();
  });
}

/** A hidden tab cannot provide reliable rendering/timing evidence. Cancel its
 * disposable frame, not the model request, and rerun the check on return. */
export async function runVisibleInteractiveProbe(
  run: (signal: AbortSignal) => Promise<InteractiveCheck>, signal: AbortSignal,
  lifecycle: InteractiveProbeLifecycle = {},
): Promise<InteractiveCheck> {
  let waiting = false;
  let retriedCapture = false;
  const setWaiting = (next: boolean) => {
    if (next === waiting) return;
    waiting = next; lifecycle.onVisibilityWait?.(next);
  };
  try {
    for (;;) {
      if (signal.aborted) throw stopped();
      setWaiting(document.visibilityState === 'hidden');
      await waitForVisible(signal);
      if (signal.aborted) throw stopped();
      setWaiting(false);
      const attempt = new AbortController();
      let interrupted = false;
      const abort = () => attempt.abort();
      const visibility = () => {
        if (document.visibilityState !== 'hidden') return;
        interrupted = true; setWaiting(true); attempt.abort();
      };
      signal.addEventListener('abort', abort, { once: true });
      document.addEventListener('visibilitychange', visibility);
      try {
        visibility();
        const result = await run(attempt.signal);
        if (signal.aborted) throw stopped();
        if (interrupted || document.visibilityState === 'hidden') continue;
        if (result.captureError && lifecycle.retryCapture && !retriedCapture) {
          retriedCapture = true; lifecycle.onCaptureRetry?.(); continue;
        }
        return result;
      } catch (error) {
        if (signal.aborted) throw stopped();
        if (!interrupted) throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        document.removeEventListener('visibilitychange', visibility);
      }
    }
  } finally { setWaiting(false); }
}
