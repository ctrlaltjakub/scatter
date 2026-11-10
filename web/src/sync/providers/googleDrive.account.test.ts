import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGoogleDriveSourceAccessToken, clearGoogleDriveToken, GoogleDriveAuthorizationRejected,
  hasGoogleDriveAccessToken, prepareGoogleDriveAccountHint, renewGoogleDriveAccessToken,
  requestGoogleDriveSourceAccessToken, requestGoogleDriveToken,
} from './googleDrive';

const tokenKey = 'scatter.google-drive-token.v1';
const accountKey = 'scatter.google-drive-account.v1';
const account = 'chosen@example.invalid';
const other = 'other@example.invalid';
const about = (emailAddress: string) => Response.json({ user: { emailAddress } });
const savedGrant = (accessToken: string, lifetime = 3_600_000) =>
  localStorage.setItem(tokenKey, JSON.stringify({ accessToken, expiresAt: Date.now() + lifetime }));
function setupGoogle() {
  const oauth = window.google?.accounts?.oauth2;
  type Config = Parameters<NonNullable<typeof oauth>['initTokenClient']>[0];
  const init = vi.fn((config: Config) => ({
    callback: config.callback,
    requestAccessToken: vi.fn(() => config.callback({ access_token: 'returned-grant', expires_in: 3600 })),
  }));
  window.google = { accounts: { oauth2: { initTokenClient: init } } };
  return init;
}

beforeEach(() => {
  clearGoogleDriveToken();
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID', 'fixture-client');
});
afterEach(() => {
  clearGoogleDriveToken(); clearGoogleDriveSourceAccessToken(); delete window.google;
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('renewing the connected Drive account', () => {
  it('backfills an existing connection once, then asks for that specific account without showing a chooser', async () => {
    const init = setupGoogle();
    savedGrant('existing-grant');
    const fetch = vi.fn().mockResolvedValueOnce(about('Chosen@example.invalid')).mockResolvedValueOnce(about(account));
    vi.stubGlobal('fetch', fetch);
    await Promise.all([prepareGoogleDriveAccountHint(), prepareGoogleDriveAccountHint()]);
    await prepareGoogleDriveAccountHint();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
      expect.objectContaining({ headers: { Authorization: 'Bearer existing-grant' }, credentials: 'omit' }));
    expect(localStorage.getItem(accountKey)).toBe(account);
    // Even when the short-lived bearer expires, we still know which account to ask for.
    savedGrant('expired', -1);
    expect(hasGoogleDriveAccessToken()).toBe(false);
    expect(localStorage.getItem(tokenKey)).toBeNull();
    const renewed = renewGoogleDriveAccessToken();
    expect(init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      scope: 'https://www.googleapis.com/auth/drive.appdata', include_granted_scopes: false, login_hint: account,
    }));
    expect(init.mock.results[0]?.value.requestAccessToken).toHaveBeenCalledExactlyOnceWith({ prompt: 'none' });
    await renewed;
    expect(fetch).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
      headers: { Authorization: 'Bearer returned-grant' },
    }));
    expect(JSON.parse(localStorage.getItem(tokenKey)!)).toMatchObject({ accessToken: 'returned-grant' });
  });

  it.each(['different account', 'unavailable identity'])('does not replace the existing grant on %s', async cause => {
    setupGoogle(); savedGrant('original'); localStorage.setItem(accountKey, account);
    const original = localStorage.getItem(tokenKey);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(cause === 'different account' ? about(other) : new Response(null, { status: 503 })));
    const error = await renewGoogleDriveAccessToken().catch((caught: unknown) => caught);
    if (cause === 'different account') expect(error).toBeInstanceOf(GoogleDriveAuthorizationRejected);
    else expect(error).toHaveProperty('message', expect.stringContaining('Could not verify'));
    expect(localStorage.getItem(tokenKey)).toBe(original);
    expect(localStorage.getItem(accountKey)).toBe(account);
  });

  it('opens on the original click but verifies the old account if its lookup was still pending', async () => {
    const init = setupGoogle(); savedGrant('original');
    let identify!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { identify = resolve; }))
      .mockResolvedValueOnce(about(other));
    vi.stubGlobal('fetch', fetch);
    const preparing = prepareGoogleDriveAccountHint();
    const renewal = renewGoogleDriveAccessToken();
    expect(init.mock.results[0]?.value.requestAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    identify(about(account)); await preparing;
    await expect(renewal).rejects.toThrow('different account');
    expect(JSON.parse(localStorage.getItem(tokenKey)!)).toMatchObject({ accessToken: 'original' });
    expect(localStorage.getItem(accountKey)).toBe(account);
  });

  it('does not lock explicit account selection or file import to the sync account', async () => {
    const init = setupGoogle(); savedGrant('original'); localStorage.setItem(accountKey, account);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await requestGoogleDriveSourceAccessToken();
    expect(localStorage.getItem(accountKey)).toBe(account);
    await requestGoogleDriveToken();
    expect(init.mock.calls.every(([config]) => !config.login_hint)).toBe(true);
    expect(localStorage.getItem(accountKey)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(about(other));
    await prepareGoogleDriveAccountHint();
    expect(localStorage.getItem(accountKey)).toBe(other);
  });

  it('does not restore a disconnected account from a pending lookup or renewed grant', async () => {
    setupGoogle(); savedGrant('original');
    let reply!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { reply = resolve; })));
    const lookup = prepareGoogleDriveAccountHint();
    clearGoogleDriveToken(); reply(about(account)); await lookup;
    expect(localStorage.getItem(accountKey)).toBeNull();
    savedGrant('original'); localStorage.setItem(accountKey, account);
    const renewal = renewGoogleDriveAccessToken();
    clearGoogleDriveToken(); reply(about(account));
    await expect(renewal).rejects.toThrow('connection changed');
    expect(localStorage.getItem(tokenKey)).toBeNull();
    expect(localStorage.getItem(accountKey)).toBeNull();
  });
});
