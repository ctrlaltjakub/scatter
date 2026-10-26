import { afterEach, describe, expect, it, vi } from 'vitest';
import { runVisibleInteractiveProbe } from './interactiveVisibility';
import type { InteractiveCheck } from './interactiveTests';

const success: InteractiveCheck = { ok: true, errors: [] };
const failure = { ok: false, errors: [], captureError: 'No usable screenshot' };
function visibility() {
  const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  return (value: DocumentVisibilityState) => {
    state.mockReturnValue(value); document.dispatchEvent(new Event('visibilitychange'));
  };
}
afterEach(() => vi.restoreAllMocks());

describe('foreground-only interactive verification', () => {
  it('waits before starting a hidden check and resumes without an extra attempt', async () => {
    const setVisibility = visibility(); setVisibility('hidden');
    const run = vi.fn(async () => success), onVisibilityWait = vi.fn();
    const result = runVisibleInteractiveProbe(run, new AbortController().signal, { onVisibilityWait });
    await Promise.resolve(); expect(run).not.toHaveBeenCalled();
    expect(onVisibilityWait).toHaveBeenLastCalledWith(true);
    setVisibility('visible');
    expect(await result).toEqual(success);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onVisibilityWait.mock.calls).toEqual([[true], [false]]);
  });

  it('aborts a check on tab hide, then starts a fresh one without spending the capture retry', async () => {
    const setVisibility = visibility(), onCaptureRetry = vi.fn();
    const run = vi.fn<(signal: AbortSignal) => Promise<typeof success>>();
    run.mockImplementationOnce(signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Hidden', 'AbortError')));
    })).mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
    const result = runVisibleInteractiveProbe(run, new AbortController().signal, { retryCapture: true, onCaptureRetry });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const firstSignal = run.mock.calls[0]![0];
    setVisibility('hidden');
    expect(firstSignal.aborted).toBe(true);
    await Promise.resolve(); expect(run).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    expect(await result).toEqual(success);
    expect(run).toHaveBeenCalledTimes(3); expect(onCaptureRetry).toHaveBeenCalledTimes(1);
  });

  it('discards evidence from a tab that became hidden even when the check ignores abort', async () => {
    const setVisibility = visibility();
    let finish!: (value: typeof success) => void;
    const run = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(success);
    const result = runVisibleInteractiveProbe(run, new AbortController().signal);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    setVisibility('hidden'); setVisibility('visible'); finish({ ok: false, errors: ['Unreliable hidden result'] });
    expect(await result).toEqual(success); expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('stopping cancels promptly, including while waiting (hidden: %s)', async hidden => {
    const setVisibility = visibility(); if (hidden) setVisibility('hidden');
    const controller = new AbortController(), waiting = vi.fn();
    const run = vi.fn((signal: AbortSignal) => new Promise<typeof success>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
    }));
    const result = runVisibleInteractiveProbe(run, controller.signal, { onVisibilityWait: waiting });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    if (!hidden) await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    controller.abort(); await rejected;
    setVisibility('visible'); expect(run).toHaveBeenCalledTimes(hidden ? 0 : 1);
    if (hidden) expect(waiting).toHaveBeenLastCalledWith(false);
  });

  it.each([false, true])('only retries capture once when explicitly enabled (retry: %s)', async retryCapture => {
    visibility(); const run = vi.fn(async () => failure);
    expect(await runVisibleInteractiveProbe(run, new AbortController().signal, { retryCapture })).toEqual(failure);
    expect(run).toHaveBeenCalledTimes(retryCapture ? 2 : 1);
  });

  it('does not retry program failures or default capability-test captures', async () => {
    visibility(); const run = vi.fn(async () => ({ ok: false, errors: ['Broken control'] }));
    await runVisibleInteractiveProbe(run, new AbortController().signal, { retryCapture: true });
    expect(run).toHaveBeenCalledTimes(1);
    const capture = vi.fn(async () => failure);
    await runVisibleInteractiveProbe(capture, new AbortController().signal);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
