import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncFailureMessage, syncRequestSignal } from './requestTimeout';
import { GoogleDriveSyncProvider } from './providers/googleDrive';
import { WebDavSyncProvider } from './providers/webdav';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('bounded sync requests', () => {
  it('gives metadata one minute and file transfers five, while preserving caller cancellation', () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    syncRequestSignal({}); expect(timeout).toHaveBeenLastCalledWith(60_000);
    syncRequestSignal({ body: new Blob(['asset']) }); expect(timeout).toHaveBeenLastCalledWith(300_000);
    syncRequestSignal({}, true); expect(timeout).toHaveBeenLastCalledWith(300_000);
    const caller = new AbortController();
    const signal = syncRequestSignal({ signal: caller.signal });
    caller.abort(); expect(signal.aborted).toBe(true);
  });

  it.each(['google-drive', 'webdav'])('aborts a stalled %s connection check instead of waiting indefinitely', async kind => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    localStorage.setItem('scatter.google-drive-token.v1', JSON.stringify({ accessToken: 'synthetic-token', expiresAt: Date.now() + 3600000 }));
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const provider = kind === 'google-drive' ? new GoogleDriveSyncProvider()
      : new WebDavSyncProvider({ baseUrl: 'https://dav.example.test/', username: 'test', appPassword: 'test', folder: 'test' });
    const result = provider.test().catch(error => error);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    deadline.abort(new DOMException('Timed out', 'TimeoutError'));
    expect(syncFailureMessage(await result)).toContain('Check your connection and try again');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['google-drive', 'webdav'])('keeps the deadline active while reading a %s response body', async kind => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    localStorage.setItem('scatter.google-drive-token.v1', JSON.stringify({ accessToken: 'synthetic-token', expiresAt: Date.now() + 3600000 }));
    const readBody = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = () => {
        readBody();
        return new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        });
      };
      return { ok: true, status: 200, json: body, text: body } as unknown as Response;
    });
    const provider = kind === 'google-drive' ? new GoogleDriveSyncProvider()
      : new WebDavSyncProvider({ baseUrl: 'https://dav.example.test/', username: 'test', appPassword: 'test', folder: 'test' });
    const result = provider.list().catch(error => error);
    await vi.waitFor(() => expect(readBody).toHaveBeenCalledOnce());
    deadline.abort(new DOMException('Timed out', 'TimeoutError'));
    expect(syncFailureMessage(await result)).toContain('Check your connection and try again');
  });
});
