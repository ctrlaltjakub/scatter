import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleDriveSyncProvider,
  clearGoogleDriveSourceAccessToken,
  clearGoogleDriveToken,
  googleDriveTokenNeedsRefresh,
  installGoogleDriveGestureRefresh,
  requestGoogleDriveToken,
  requestGoogleDriveSourceAccessToken,
  resolveGoogleDriveClientId,
} from './googleDrive';

describe('Google Drive client configuration', () => {
  it('uses an explicit deployment client before the shared client', () => {
    expect(resolveGoogleDriveClientId(' custom-client ', 'https://scatter.study'))
      .toBe('custom-client');
  });

  it('uses Scatter\'s shared public client on the canonical site and registered local origins', () => {
    expect(resolveGoogleDriveClientId(undefined, 'https://scatter.study'))
      .toMatch(/\.apps\.googleusercontent\.com$/);
    expect(resolveGoogleDriveClientId('', 'http://localhost:5173'))
      .toMatch(/\.apps\.googleusercontent\.com$/);
    expect(resolveGoogleDriveClientId(undefined, 'https://www.scatter.study'))
      .toMatch(/\.apps\.googleusercontent\.com$/);
    expect(resolveGoogleDriveClientId(undefined, 'http://127.0.0.1:3001'))
      .toMatch(/\.apps\.googleusercontent\.com$/);
  });

  it('requires an explicit client for unregistered self-hosted origins', () => {
    expect(resolveGoogleDriveClientId(undefined, 'https://self-hosted.example')).toBeNull();
  });
});

describe('Google Drive synchronization provider', () => {
  beforeEach(() => {
    clearGoogleDriveToken();
    clearGoogleDriveSourceAccessToken();
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID', 'client-id.apps.googleusercontent.com');
    (window as typeof window & { google?: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (value: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => void;
          }) => ({
            callback: config.callback,
            requestAccessToken: () => config.callback({ access_token: 'token', expires_in: 3600 }),
          }),
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearGoogleDriveToken();
    clearGoogleDriveSourceAccessToken();
    delete (window as typeof window & { google?: unknown }).google;
  });

  it('reuses the selected-file token and avoids reopening the account chooser', async () => {
    const prompts: Array<{ prompt?: string } | undefined> = [];
    let requests = 0;
    (window.google!.accounts!.oauth2!.initTokenClient as unknown) = (config: {
      callback: (value: { access_token: string; expires_in: number }) => void;
    }) => ({
      callback: config.callback,
      requestAccessToken: (options?: { prompt?: string }) => {
        requests += 1;
        prompts.push(options);
        config.callback({ access_token: 'source-token', expires_in: 3600 });
      },
    });

    await expect(requestGoogleDriveSourceAccessToken()).resolves.toBe('source-token');
    await expect(requestGoogleDriveSourceAccessToken()).resolves.toBe('source-token');

    expect(requests).toBe(1);
    expect(prompts).toEqual([{ prompt: '' }]);
  });

  it('requests the hidden app-data scope and lists only Scatter objects', async () => {
    await requestGoogleDriveToken();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ files: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await new GoogleDriveSyncProvider().list();
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain('spaces=appDataFolder');
    expect(new URL(requestUrl).searchParams.get('q')).toContain("name contains 'scatter-v1.'");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('captures a starting cursor before the baseline listing so concurrent uploads are not lost', async () => {
    await requestGoogleDriveToken();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ startPageToken: 'before-list' }))
      .mockResolvedValueOnce(Response.json({ files: [{ id: 'one', name: 'scatter-v1.asset.cA.YQ.bin' }] }));
    expect(await new GoogleDriveSyncProvider().changes()).toMatchObject({
      reset: true, cursor: 'before-list', objects: [{ id: 'one' }],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/changes/startPageToken');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/files?');
  });

  it('applies paginated changes in order including removals, re-additions and renamed files', async () => {
    await requestGoogleDriveToken();
    const file = { id: 'one', name: 'scatter-v1.asset.cA.YQ.bin' };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ nextPageToken: 'page-2', changes: [
        { fileId: 'one', file }, { fileId: 'two', removed: true },
        { fileId: 'renamed', file: { id: 'renamed', name: 'unrelated' } },
      ] }))
      .mockResolvedValueOnce(Response.json({ newStartPageToken: 'final', changes: [
        { fileId: 'one', removed: true }, { fileId: 'two', file: { ...file, id: 'two' } },
      ] }));
    const result = await new GoogleDriveSyncProvider().changes('first');
    expect(result).toEqual({ reset: false, cursor: 'final', objects: [{ id: 'two', name: file.name }], removedIds: ['renamed', 'one'] });
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('pageToken')).toBe('page-2');
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('spaces')).toBe('appDataFolder');
  });

  it('rebuilds on a rejected cursor and never accepts an incomplete delta', async () => {
    await requestGoogleDriveToken();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 410 }))
      .mockResolvedValueOnce(Response.json({ startPageToken: 'new' }))
      .mockResolvedValueOnce(Response.json({ files: [] }));
    expect(await new GoogleDriveSyncProvider().changes('old')).toEqual({ reset: true, cursor: 'new', objects: [], removedIds: [] });
    fetchMock.mockResolvedValueOnce(Response.json({ changes: [] }));
    await expect(new GoogleDriveSyncProvider().changes('new')).rejects.toThrow('incomplete change listing');
  });

  it('places uploaded snapshots in appDataFolder rather than the visible Drive', async () => {
    await requestGoogleDriveToken();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'file', name: 'scatter-v1.test', size: '4', modifiedTime: new Date(0).toISOString(),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await new GoogleDriveSyncProvider().write('scatter-v1.test', new Blob(['data']));
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(Blob);
    expect(await (body as Blob).text()).toContain('"parents":["appDataFolder"]');
  });

  it('keeps the short-lived token across app sessions until it expires', async () => {
    await requestGoogleDriveToken();
    sessionStorage.clear();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ files: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await new GoogleDriveSyncProvider().list();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('renews an approved grant on the next user gesture near expiry', async () => {
    localStorage.setItem('scatter.google-drive-token.v1', JSON.stringify({
      accessToken: 'old-token',
      expiresAt: Date.now() + 60_000,
    }));
    expect(googleDriveTokenNeedsRefresh()).toBe(true);
    let refreshed = 0;
    const cleanup = await installGoogleDriveGestureRefresh({
      onRefreshed: () => { refreshed += 1; },
    });

    window.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(refreshed).toBe(1));
    expect(googleDriveTokenNeedsRefresh()).toBe(false);
    cleanup();
  });

  it('waits for gesture renewal when the same click starts a Drive request', async () => {
    localStorage.setItem('scatter.google-drive-token.v1', JSON.stringify({
      accessToken: 'expired-token', expiresAt: Date.now() - 1,
    }));
    let finish!: (value: { access_token: string; expires_in: number }) => void;
    window.google!.accounts!.oauth2!.initTokenClient = config => {
      finish = config.callback;
      return { callback: config.callback, requestAccessToken: vi.fn() };
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ files: [] }));
    const cleanup = await installGoogleDriveGestureRefresh({ onRefreshed: vi.fn() });
    window.dispatchEvent(new Event('pointerdown'));
    const result = new GoogleDriveSyncProvider().list().catch(error => error);
    expect(fetchMock).not.toHaveBeenCalled();
    finish({ access_token: 'renewed-token', expires_in: 3600 });
    const value = await result;
    cleanup();
    expect(value).toEqual([]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer renewed-token' });
  });

  it('shares one renewal between a gesture and an explicit connection request', async () => {
    const callbacks: Array<(value: { access_token: string; expires_in: number }) => void> = [];
    const request = vi.fn();
    window.google!.accounts!.oauth2!.initTokenClient = config => {
      callbacks.push(config.callback);
      return { callback: config.callback, requestAccessToken: request };
    };
    const cleanup = await installGoogleDriveGestureRefresh({ onRefreshed: vi.fn() });
    window.dispatchEvent(new Event('pointerdown'));
    const explicit = requestGoogleDriveToken();
    await Promise.resolve();
    callbacks.forEach(callback => callback({ access_token: 'renewed-token', expires_in: 3600 }));
    await explicit;
    cleanup();
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not discard a newly renewed token when an older request returns 401', async () => {
    await requestGoogleDriveToken();
    let finishOldRequest!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise(resolve => { finishOldRequest = resolve; }))
      .mockResolvedValueOnce(Response.json({ files: [] }));
    const result = new GoogleDriveSyncProvider().list().catch(error => error);
    await vi.waitFor(() => expect(finishOldRequest).toBeTypeOf('function'));
    window.google!.accounts!.oauth2!.initTokenClient = config => ({
      callback: config.callback,
      requestAccessToken: () => config.callback({ access_token: 'new-token', expires_in: 3600 }),
    });
    await requestGoogleDriveToken();
    finishOldRequest(new Response('', { status: 401 }));
    expect(await result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer new-token' });
    expect(googleDriveTokenNeedsRefresh()).toBe(false);
  });

  it('does not renew after Google Drive sync has been disabled', async () => {
    let requests = 0;
    (window.google!.accounts!.oauth2!.initTokenClient as unknown) = (config: {
      callback: (value: { access_token: string; expires_in: number }) => void;
    }) => ({
      callback: config.callback,
      requestAccessToken: () => { requests += 1; },
    });
    const cleanup = await installGoogleDriveGestureRefresh({
      shouldRefresh: () => false,
      onRefreshed: () => undefined,
    });

    window.dispatchEvent(new Event('pointerdown'));
    expect(requests).toBe(0);
    cleanup();
  });

  it('waits instead of attempting renewal while the browser is offline', async () => {
    let requests = 0;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    (window.google!.accounts!.oauth2!.initTokenClient as unknown) = () => ({
      callback: () => undefined,
      requestAccessToken: () => { requests += 1; },
    });
    const cleanup = await installGoogleDriveGestureRefresh({
      onRefreshed: () => undefined,
    });

    window.dispatchEvent(new Event('pointerdown'));
    expect(requests).toBe(0);
    cleanup();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });
});
