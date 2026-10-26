import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearGoogleDriveSourceAccessToken, clearGoogleDriveToken, hasGoogleDriveAccessToken,
  requestGoogleDriveSourceAccessToken, requestGoogleDriveToken } from './googleDrive';

const scriptSelector = 'script[src="https://accounts.google.com/gsi/client"]';
function installGoogle() {
  window.google = { accounts: { oauth2: { initTokenClient: config => ({
    callback: config.callback,
    requestAccessToken: () => config.callback({ access_token: 'synthetic-token', expires_in: 3600 }),
  }) } } };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID', 'synthetic-client.apps.googleusercontent.com');
  clearGoogleDriveToken(); clearGoogleDriveSourceAccessToken();
  delete window.google;
});
afterEach(() => {
  document.querySelectorAll(scriptSelector).forEach(script => script.remove());
  delete window.google;
  clearGoogleDriveToken(); clearGoogleDriveSourceAccessToken();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('Google authorization failure recovery', () => {
  it('removes a failed identity script so a retry loads a fresh copy', async () => {
    const first = requestGoogleDriveToken().catch(error => error);
    const broken = document.querySelector(scriptSelector)!;
    broken.dispatchEvent(new Event('error'));
    expect(await first).toHaveProperty('message', expect.stringContaining('Could not load'));
    expect(document.querySelector(scriptSelector)).toBeNull();

    const retry = requestGoogleDriveToken();
    const replacement = document.querySelector(scriptSelector)!;
    expect(replacement).not.toBe(broken);
    installGoogle(); replacement.dispatchEvent(new Event('load'));
    await retry;
    expect(hasGoogleDriveAccessToken()).toBe(true);
  });

  it('bounds a stale or blocked script load and shares it between sync and file import', async () => {
    vi.useFakeTimers();
    const stale = document.createElement('script'); stale.src = 'https://accounts.google.com/gsi/client';
    document.head.appendChild(stale);
    stale.dispatchEvent(new Event('error')); // Failure occurred before either consumer subscribed.
    const sync = requestGoogleDriveToken().catch(error => error);
    const source = requestGoogleDriveSourceAccessToken().catch(error => error);
    expect(document.querySelectorAll(scriptSelector)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await sync).toHaveProperty('message', expect.stringContaining('could not load in time'));
    expect(await source).toHaveProperty('message', expect.stringContaining('could not load in time'));
    expect(document.querySelector(scriptSelector)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a loaded script with no usable SDK and permits retry', async () => {
    const request = requestGoogleDriveToken().catch(error => error);
    document.querySelector(scriptSelector)!.dispatchEvent(new Event('load'));
    expect(await request).toHaveProperty('message', expect.stringContaining('did not initialize'));
    expect(document.querySelector(scriptSelector)).toBeNull();
    installGoogle(); await requestGoogleDriveToken();
    expect(hasGoogleDriveAccessToken()).toBe(true);
  });

  describe.each([
    ['sync', requestGoogleDriveToken], ['file import', requestGoogleDriveSourceAccessToken],
  ] as const)('%s', (_name, authorize) => {
    it.each(['popup_closed', 'popup_failed_to_open'])('handles %s immediately and ignores late responses', async type => {
      vi.useFakeTimers(); installGoogle();
      let lateResponse!: () => void;
      window.google!.accounts!.oauth2!.initTokenClient = config => ({
        callback: config.callback,
        requestAccessToken: () => {
          lateResponse = () => config.callback({ access_token: 'late-token', expires_in: 3600 });
          config.error_callback?.({ type });
        },
      });
      await expect(authorize()).rejects.toThrow(type === 'popup_closed' ? 'was closed' : 'Allow pop-ups');
      lateResponse();
      expect(hasGoogleDriveAccessToken()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      installGoogle(); await authorize();
    });

    it('cleans up synchronous SDK errors and unanswered authorization timeouts', async () => {
      vi.useFakeTimers(); installGoogle();
      window.google!.accounts!.oauth2!.initTokenClient = () => { throw new Error('SDK failed'); };
      await expect(authorize()).rejects.toThrow('SDK failed');
      expect(vi.getTimerCount()).toBe(0);
      window.google!.accounts!.oauth2!.initTokenClient = config => ({ callback: config.callback, requestAccessToken: () => {} });
      const pending = authorize().catch(error => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toHaveProperty('message', expect.stringContaining('did not finish'));
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
