import { sha256Hex } from '../codec';
import { SyncNamespace } from '../namespace';
import type { RemoteChanges, RemoteObject, SyncProvider } from '../types';
import { syncRequestSignal } from '../requestTimeout';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_SELECTED_FILES_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'scatter.google-drive-token.v1';
const ACCOUNT_KEY = 'scatter.google-drive-account.v1';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SIMPLE_LIMIT = 5 * 1024 * 1024;
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const POPUP_RESULT_GRACE_MS = 2_000;
const IDENTITY_LOAD_TIMEOUT_MS = 15_000;
const RECONNECT_REQUIRED_ERRORS = new Set([
  'access_denied',
  'account_selection_required',
  'consent_required',
  'interaction_required',
  'invalid_client',
  'invalid_grant',
  'login_required',
  'unauthorized_client',
]);
// OAuth client IDs are public identifiers. Scatter's shared client is limited
// by Google to the canonical site and the exact development origins below, so
// shipping it here does not expose a credential or make it usable elsewhere;
// the canonical deployment therefore does not depend on a Vercel secret.
const SCATTER_GOOGLE_DRIVE_CLIENT_ID =
  '992714113012-ciarnstch3ga4ubrsk6ai4qbl3e2f78s.apps.googleusercontent.com';
const SCATTER_GOOGLE_DRIVE_ORIGINS = new Set([
  'https://scatter.study',
  'https://www.scatter.study',
  'https://beta.scatter.study',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
]);

export function isScatterGoogleDriveOrigin(origin: string): boolean {
  return SCATTER_GOOGLE_DRIVE_ORIGINS.has(origin);
}

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

let sourceAccessToken: StoredToken | null = null;
// A pointerdown can start renewal before that same click starts a sync action.
// Both paths must share the grant instead of racing or opening two popups.
let syncTokenRequest: Promise<void> | null = null;
let connectionGeneration = 0;
let accountLookup: { token: string; promise: Promise<void> } | null = null;
let identityLoad: Promise<void> | null = null;

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleTokenClient {
  requestAccessToken(config?: { prompt?: string }): void;
  callback: (response: GoogleTokenResponse) => void;
}

type GooglePrompt = '' | 'none' | 'consent' | 'select_account';

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            login_hint?: string;
            include_granted_scopes?: boolean;
            callback: (response: GoogleTokenResponse) => void;
            error_callback?: (error: { type: string }) => void;
          }): GoogleTokenClient;
        };
      };
    };
  }
}

export class GoogleDriveReconnectRequired extends Error {}
export class GoogleDriveAuthorizationRejected extends Error {}
export class GoogleDriveRenewalWindowError extends Error {}

export function resolveGoogleDriveClientId(
  configuredClientId: string | undefined,
  origin: string,
): string | null {
  const configured = configuredClientId?.trim();
  if (configured) return configured;
  return isScatterGoogleDriveOrigin(origin)
    ? SCATTER_GOOGLE_DRIVE_CLIENT_ID
    : null;
}

function readStoredToken(): StoredToken | null {
  const parse = (raw: string | null): StoredToken | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredToken>;
      if (typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'number') return null;
      return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
    } catch {
      return null;
    }
  };
  try {
    const persistent = parse(localStorage.getItem(TOKEN_KEY));
    if (persistent) return persistent;
    localStorage.removeItem(TOKEN_KEY);

    // Migrate tokens created by the first sync release. They lived in
    // sessionStorage, so a refresh worked but closing/restarting the app did
    // not. The token remains short-lived and limited to Drive appData.
    const legacy = parse(sessionStorage.getItem(TOKEN_KEY));
    if (!legacy) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    localStorage.setItem(TOKEN_KEY, JSON.stringify(legacy));
    sessionStorage.removeItem(TOKEN_KEY);
    return legacy;
  } catch {
    return null;
  }
}

function loadStoredToken(): StoredToken | null {
  const token = readStoredToken();
  if (token && token.expiresAt > Date.now() + 30_000) return token;
  if (token) removeStoredToken(); // Expiry is not a disconnect; keep the selected account.
  return null;
}

/** Reuse authorization already held by this browser, never credentials from
 * an imported settings file. Revoked tokens still use the normal 401 flow. */
export function hasGoogleDriveAccessToken(): boolean {
  return loadStoredToken() !== null;
}

/** Browser-only token flow has no refresh token. This tells the coordinator
 * when to renew on the next real user gesture, shortly before expiry. */
export function googleDriveTokenNeedsRefresh(now = Date.now()): boolean {
  const token = readStoredToken();
  return !token || token.expiresAt <= now + TOKEN_REFRESH_WINDOW_MS;
}

function storedAccount(): string | null {
  try { return localStorage.getItem(ACCOUNT_KEY); } catch { return null; }
}

function setStoredAccount(email: string | null): void {
  try {
    if (email) localStorage.setItem(ACCOUNT_KEY, email);
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch { /* Browser storage may be unavailable. */ }
}

/** Google accepts an email as an OAuth login_hint. Drive exposes the connected
 * user's own address with our existing appData scope; no profile or file access. */
async function driveAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(`${DRIVE_API}/about?fields=user(emailAddress)`, {
      headers: { Authorization: `Bearer ${accessToken}` }, credentials: 'omit',
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const { user } = await response.json() as { user?: { emailAddress?: string } };
    const email = user?.emailAddress?.trim().toLowerCase();
    return email?.includes('@') ? email : null;
  } catch { return null; }
}

/** Prepare before the next click, including for connections made before hints
 * existed. Opening an OAuth window must not wait for an asynchronous lookup. */
export function prepareGoogleDriveAccountHint(): Promise<void> {
  const token = readStoredToken();
  if (storedAccount() || !token || token.expiresAt <= Date.now() || navigator.onLine === false) return Promise.resolve();
  if (accountLookup?.token === token.accessToken) return accountLookup.promise;
  const generation = connectionGeneration;
  const lookup = { token: token.accessToken, promise: driveAccountEmail(token.accessToken).then(email => {
    if (email && generation === connectionGeneration && readStoredToken()?.accessToken === token.accessToken) setStoredAccount(email);
  }).finally(() => { if (accountLookup === lookup) accountLookup = null; }) };
  accountLookup = lookup;
  return lookup.promise;
}

function storeToken(response: GoogleTokenResponse): StoredToken {
  if (!response.access_token) {
    const message = response.error_description || response.error || 'Google Drive authorization was cancelled.';
    if (!response.error || RECONNECT_REQUIRED_ERRORS.has(response.error)) {
      throw new GoogleDriveAuthorizationRejected(message);
    }
    throw new Error(message);
  }
  const token = {
    accessToken: response.access_token,
    expiresAt: Date.now() + Math.max(60, response.expires_in ?? 3600) * 1000,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  return token;
}

function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (identityLoad) return identityLoad;
  const loading = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? document.createElement('script');
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      script.removeEventListener('load', loaded);
      script.removeEventListener('error', failed);
      if (error) { script.remove(); reject(error); }
      else resolve();
    };
    const loaded = () => finish(window.google?.accounts?.oauth2 ? undefined
      : new Error('Google authorization did not initialize. Please try connecting again.'));
    const failed = () => finish(new Error('Could not load Google authorization. Check your connection or content blocker, then try again.'));
    const timeout = window.setTimeout(() => finish(new Error('Google authorization could not load in time. Check your connection or content blocker, then try again.')), IDENTITY_LOAD_TIMEOUT_MS);
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', failed, { once: true });
    if (existing) return;
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  });
  identityLoad = loading.finally(() => { identityLoad = null; });
  return identityLoad;
}

function googlePopupError(type: string): Error {
  return new Error(type === 'popup_failed_to_open'
    ? 'Google sign-in could not open. Allow pop-ups for this site, then try again.'
    : type === 'popup_closed'
      ? 'Google sign-in was closed before it finished. You can try again or choose another setup method.'
      : 'Google sign-in could not finish. Please try again.');
}

function requestLoadedGoogleDriveToken(prompt: GooglePrompt | undefined, generation: number): Promise<void> {
  const oauth = window.google?.accounts?.oauth2;
  if (!oauth) return Promise.reject(new Error('Google authorization did not initialize.'));
  const disconnected = () => new Error('The Google Drive connection changed before authorization finished.');
  if (generation !== connectionGeneration) return Promise.reject(disconnected());
  const hint = (prompt === 'none' || prompt === '') ? storedAccount() : null;
  const identifyingExistingAccount = !hint && (prompt === 'none' || prompt === '') ? accountLookup?.promise : undefined;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let closeTimer: number | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.clearTimeout(closeTimer);
      action();
    };
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error('Google authorization did not finish. Reconnect Google Drive.')));
    }, TOKEN_REQUEST_TIMEOUT_MS);
    const noPopupResult = (blocked: boolean) => {
      const reason = blocked ? 'Google could not open its renewal window. Allow pop-ups for this site.'
        : 'Google closed the renewal window without returning an authorization result.';
      reject(hasGoogleDriveAccessToken()
        ? new GoogleDriveRenewalWindowError(`${reason} Your current access is still valid.`)
        : new GoogleDriveAuthorizationRejected(`${reason} Reconnect Google Drive to choose the sync account.`));
    };
    const accept = async (response: GoogleTokenResponse) => {
      // A legacy token may still be identifying itself when the user clicks.
      // Open synchronously, but don't replace it until that check finishes.
      if (response.access_token && identifyingExistingAccount) await identifyingExistingAccount;
      if (generation !== connectionGeneration) throw disconnected();
      const expectedAccount = hint ?? (prompt === 'none' || prompt === '' ? storedAccount() : null);
      if (response.access_token && identifyingExistingAccount && !expectedAccount) {
        throw new Error('Could not identify the connected Google account. Try again or reconnect Google Drive.');
      }
      if (response.access_token && expectedAccount) {
        // A login hint is not proof. Never use another account's token for sync.
        const email = await driveAccountEmail(response.access_token);
        if (generation !== connectionGeneration || storedAccount() !== expectedAccount) throw disconnected();
        if (!email) throw new Error('Could not verify the Google account for renewal. Try again.');
        if (email !== expectedAccount) throw new GoogleDriveAuthorizationRejected('Google returned a different account. Reconnect Google Drive to choose the sync account.');
      }
      storeToken(response);
      if (!expectedAccount) setStoredAccount(null); // A successful explicit connection can select another account.
    };
    try {
      const client = oauth.initTokenClient({
        client_id: resolveGoogleDriveClientId(
          process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID,
          window.location.origin,
        )!,
        scope: DRIVE_SCOPE,
        include_granted_scopes: false, // Don't fold previously approved Picker access into the sync token.
        ...(hint ? { login_hint: hint } : {}),
        error_callback: error => {
          if (settled) return;
          if (prompt === 'none' && error.type === 'popup_closed') {
            // GIS polls popup.closed separately from receiving Google's OAuth
            // message. A quiet popup can close before the opener handles it.
            closeTimer ??= window.setTimeout(() => finish(() => noPopupResult(false)), POPUP_RESULT_GRACE_MS);
          } else finish(() => prompt === 'none' && error.type === 'popup_failed_to_open'
            ? noPopupResult(true) : reject(googlePopupError(error.type)));
        },
        callback: response => finish(() => { void accept(response).then(resolve, reject); }),
      });
      client.requestAccessToken(prompt === undefined ? undefined : { prompt });
    } catch (error) { finish(() => reject(error)); }
  });
}

export function requestGoogleDriveToken(prompt?: GooglePrompt): Promise<void> {
  if (syncTokenRequest) return syncTokenRequest;
  const clientId = resolveGoogleDriveClientId(
    process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID,
    window.location.origin,
  );
  if (!clientId) return Promise.reject(new Error('Google Drive sync is not configured for this Scatter deployment.'));
  // Start immediately when the SDK is ready, preserving the user gesture.
  const generation = connectionGeneration;
  const request = window.google?.accounts?.oauth2
    ? requestLoadedGoogleDriveToken(prompt, generation)
    : loadGoogleIdentity().then(() => requestLoadedGoogleDriveToken(prompt, generation));
  const shared = request.finally(() => { if (syncTokenRequest === shared) syncTokenRequest = null; });
  syncTokenRequest = shared;
  return shared;
}

/** Call from an explicit sync/restore click, before other asynchronous work. */
export function ensureGoogleDriveAccessToken(): Promise<void> {
  if (syncTokenRequest) return syncTokenRequest;
  return googleDriveTokenNeedsRefresh() ? requestGoogleDriveToken('') : Promise.resolve();
}

/** Reuse the approved sync grant. Only an explicit reconnect may open a sign-in screen. */
export function renewGoogleDriveAccessToken(): Promise<void> {
  return requestGoogleDriveToken('none');
}

/** Request a short-lived, non-persisted token for files the user explicitly
 * selects in Google Picker. Keeping it separate prevents the broader picker
 * token from replacing Scatter sync's appData-only token. */
export async function requestGoogleDriveSourceAccessToken(): Promise<string> {
  if (sourceAccessToken && sourceAccessToken.expiresAt > Date.now() + 30_000) {
    return sourceAccessToken.accessToken;
  }
  sourceAccessToken = null;
  const clientId = resolveGoogleDriveClientId(
    process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID,
    window.location.origin,
  );
  if (!clientId) throw new Error('Google Drive import is not configured for this Scatter deployment.');
  await loadGoogleIdentity();
  const oauth = window.google?.accounts?.oauth2;
  if (!oauth) throw new Error('Google authorization did not initialize.');
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      action();
    };
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error('Google Drive import authorization did not finish.')));
    }, TOKEN_REQUEST_TIMEOUT_MS);
    try {
      const client = oauth.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SELECTED_FILES_SCOPE,
        error_callback: error => finish(() => reject(googlePopupError(error.type))),
        callback: (response) => finish(() => {
          if (response.access_token) {
            sourceAccessToken = {
              accessToken: response.access_token,
              expiresAt: Date.now() + Math.max(60, response.expires_in ?? 3600) * 1000,
            };
            resolve(response.access_token);
          }
          else reject(new GoogleDriveAuthorizationRejected(
            response.error_description || response.error || 'Google Drive import was cancelled.',
          ));
        }),
      });
      // Reuse the approved account unless Google actually needs consent.
      client.requestAccessToken({ prompt: '' });
    } catch (error) { finish(() => reject(error)); }
  });
}

export function clearGoogleDriveSourceAccessToken(): void {
  sourceAccessToken = null;
}

/**
 * Keep a browser-only Drive connection alive without a backend refresh token.
 * Google requires every replacement access token to begin from a user gesture,
 * so the identity library is prepared ahead of time and an already-approved
 * grant is renewed without a sign-in or consent screen on the next click/key press.
 * If the Google session needs interaction, only an explicit Reconnect opens sign-in.
 */
export async function installGoogleDriveGestureRefresh(callbacks: {
  onRefreshed: () => void;
  onError?: (error: Error) => void;
  shouldRefresh?: () => boolean;
}): Promise<() => void> {
  const clientId = resolveGoogleDriveClientId(
    process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID,
    window.location.origin,
  );
  if (!clientId) throw new Error('Google Drive sync is not configured for this Scatter deployment.');
  await loadGoogleIdentity();

  let disposed = false;
  let requesting = false;
  let retryAfter = 0;
  const renew = () => {
    if (disposed
      || callbacks.shouldRefresh?.() === false
      || requesting
      || Date.now() < retryAfter
      || navigator.onLine === false
      || !googleDriveTokenNeedsRefresh()) return;
    requesting = true;
    void renewGoogleDriveAccessToken().then(() => {
      if (disposed) return;
      retryAfter = 0;
      callbacks.onRefreshed();
    }).catch((cause) => {
      if (disposed) return;
      retryAfter = Date.now() + 60_000;
      // An ambiguous close shouldn't flash another popup on every click/minute
      // while the current token can still carry sync traffic.
      if (cause instanceof GoogleDriveRenewalWindowError) {
        retryAfter = Math.max(retryAfter, (readStoredToken()?.expiresAt ?? 0) - 30_000);
      }
      callbacks.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    }).finally(() => { requesting = false; });
  };

  window.addEventListener('pointerdown', renew, true);
  window.addEventListener('keydown', renew, true);
  return () => {
    disposed = true;
    window.removeEventListener('pointerdown', renew, true);
    window.removeEventListener('keydown', renew, true);
  };
}

function removeStoredToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export function clearGoogleDriveToken(): void {
  connectionGeneration++;
  syncTokenRequest = null;
  accountLookup = null;
  removeStoredToken();
  setStoredAccount(null);
}

async function waitForDriveGrant(): Promise<void> {
  try { await syncTokenRequest; } catch (error) {
    if (!(error instanceof GoogleDriveRenewalWindowError && hasGoogleDriveAccessToken())) throw error;
  }
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await waitForDriveGrant();
  let token = loadStoredToken();
  if (!token) throw new GoogleDriveReconnectRequired('Reconnect Google Drive to resume sync.');
  const send = (accessToken: string) => fetch(url, {
    ...init,
    signal: syncRequestSignal(init, url.includes('alt=media')),
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
  });
  let response = await send(token.accessToken);
  if (response.status === 401) {
    // An old request may finish after a renewal. Retry once with that newer
    // grant; never erase it because the previous token was rejected.
    await waitForDriveGrant();
    const renewed = loadStoredToken();
    if (renewed && renewed.accessToken !== token.accessToken) {
      token = renewed;
      response = await send(token.accessToken);
    }
  }
  if (response.status === 401) {
    if (readStoredToken()?.accessToken === token.accessToken) removeStoredToken();
    throw new GoogleDriveReconnectRequired('Reconnect Google Drive to resume sync.');
  }
  return response;
}

async function multipartUpload(name: string, data: Blob): Promise<RemoteObject> {
  const boundary = `scatter_${crypto.randomUUID().replace(/-/g, '')}`;
  const metadata = JSON.stringify({ name, parents: ['appDataFolder'] });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${data.type || 'application/octet-stream'}\r\n\r\n`,
    data,
    `\r\n--${boundary}--`,
  ]);
  const response = await driveFetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,size,modifiedTime`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!response.ok) throw new Error(`Google Drive upload failed (${response.status}).`);
  const file = await response.json() as { id: string; name: string; size?: string; modifiedTime?: string };
  return {
    id: file.id, name: file.name,
    ...(file.size ? { size: Number(file.size) } : {}),
    ...(file.modifiedTime ? { modifiedAt: Date.parse(file.modifiedTime) } : {}),
  };
}

async function resumableUpload(name: string, data: Blob): Promise<RemoteObject> {
  const start = await driveFetch(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id,name,size,modifiedTime`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': data.type || 'application/octet-stream',
      'X-Upload-Content-Length': String(data.size),
    },
    body: JSON.stringify({ name, parents: ['appDataFolder'] }),
  });
  if (!start.ok) throw new Error(`Google Drive resumable upload could not start (${start.status}).`);
  const location = start.headers.get('location');
  if (!location) throw new Error('Google Drive did not return an upload location.');
  const finish = await driveFetch(location, {
    method: 'PUT',
    headers: { 'Content-Type': data.type || 'application/octet-stream' },
    body: data,
  });
  if (!finish.ok) throw new Error(`Google Drive upload failed (${finish.status}).`);
  const file = await finish.json() as { id: string; name: string; size?: string; modifiedTime?: string };
  return {
    id: file.id, name: file.name,
    ...(file.size ? { size: Number(file.size) } : {}),
    ...(file.modifiedTime ? { modifiedAt: Date.parse(file.modifiedTime) } : {}),
  };
}

export class GoogleDriveSyncProvider implements SyncProvider {
  readonly kind = 'google-drive' as const;
  private readonly namespace = new SyncNamespace();

  async indexScope(): Promise<string> {
    await syncTokenRequest;
    const token = loadStoredToken();
    if (!token) throw new GoogleDriveReconnectRequired('Reconnect Google Drive to resume sync.');
    // A new grant can belong to another account. Rebuild on authorization
    // changes rather than reuse an account's cursor for a different account.
    return `google-drive:${await sha256Hex(token.accessToken)}${this.namespace.scopeSuffix}`;
  }

  async changes(cursor?: string): Promise<RemoteChanges> {
    if (!cursor) {
      // Capture BEFORE listing: concurrent uploads during the initial scan
      // must still appear in the next delta, even if the listing missed them.
      const response = await driveFetch(`${DRIVE_API}/changes/startPageToken`);
      if (!response.ok) throw new Error(`Google Drive change tracking failed (${response.status}).`);
      const { startPageToken } = await response.json() as { startPageToken?: string };
      if (!startPageToken) throw new Error('Google Drive did not return a change token.');
      return { reset: true, objects: await this.list(), removedIds: [], cursor: startPageToken };
    }
    const objects = new Map<string, RemoteObject>();
    const removedIds = new Set<string>();
    const visited = new Set<string>();
    let pageToken = cursor;
    while (true) {
      if (visited.has(pageToken)) throw new Error('Google Drive repeated a change page.');
      visited.add(pageToken);
      const params = new URLSearchParams({
        spaces: 'appDataFolder', pageSize: '1000', pageToken, includeRemoved: 'true',
        fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,size,modifiedTime,md5Checksum,trashed))',
      });
      const response = await driveFetch(`${DRIVE_API}/changes?${params}`);
      if (response.status === 400 || response.status === 410) return this.changes();
      if (!response.ok) throw new Error(`Google Drive change listing failed (${response.status}).`);
      const page = await response.json() as {
        nextPageToken?: string; newStartPageToken?: string;
        changes?: Array<{ fileId: string; removed?: boolean; file?: {
          id: string; name: string; size?: string; modifiedTime?: string; md5Checksum?: string; trashed?: boolean;
        } }>;
      };
      for (const change of page.changes ?? []) {
        const file = change.file;
        if (change.removed || !file || file.trashed || !file.name.startsWith(this.namespace.prefix)) {
          objects.delete(change.fileId);
          removedIds.add(change.fileId);
        } else {
          removedIds.delete(change.fileId);
          objects.set(change.fileId, this.namespace.localObject({
            id: change.fileId, name: file.name,
            ...(file.size ? { size: Number(file.size) } : {}),
            ...(file.modifiedTime ? { modifiedAt: Date.parse(file.modifiedTime) } : {}),
            ...(file.md5Checksum ? { etag: file.md5Checksum } : {}),
          }));
        }
      }
      if (page.nextPageToken) { pageToken = page.nextPageToken; continue; }
      if (!page.newStartPageToken) throw new Error('Google Drive returned an incomplete change listing.');
      return { reset: false, objects: [...objects.values()], removedIds: [...removedIds], cursor: page.newStartPageToken };
    }
  }

  async test(): Promise<void> {
    const response = await driveFetch(`${DRIVE_API}/files?spaces=appDataFolder&pageSize=1&fields=files(id)`);
    if (!response.ok) throw new Error(`Google Drive connection failed (${response.status}).`);
  }

  async list(): Promise<RemoteObject[]> {
    const out: RemoteObject[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        pageSize: '1000',
        q: `trashed = false and name contains '${this.namespace.prefix}'`,
        fields: 'nextPageToken,files(id,name,size,modifiedTime,md5Checksum)',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await driveFetch(`${DRIVE_API}/files?${params}`);
      if (!response.ok) throw new Error(`Google Drive listing failed (${response.status}).`);
      const page = await response.json() as {
        nextPageToken?: string;
        files?: Array<{ id: string; name: string; size?: string; modifiedTime?: string; md5Checksum?: string }>;
      };
      for (const file of page.files ?? []) {
        if (!file.name.startsWith(this.namespace.prefix)) continue;
        out.push(this.namespace.localObject({
          id: file.id,
          name: file.name,
          ...(file.size ? { size: Number(file.size) } : {}),
          ...(file.modifiedTime ? { modifiedAt: Date.parse(file.modifiedTime) } : {}),
          ...(file.md5Checksum ? { etag: file.md5Checksum } : {}),
        }));
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  async read(object: RemoteObject): Promise<Blob> {
    this.namespace.assertObject(object);
    const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(object.id)}?alt=media`);
    if (!response.ok) throw new Error(`Google Drive download failed (${response.status}).`);
    return response.blob();
  }

  async write(name: string, data: Blob): Promise<RemoteObject> {
    const remoteName = this.namespace.remoteName(name);
    return this.namespace.localObject(await (data.size > SIMPLE_LIMIT ? resumableUpload(remoteName, data) : multipartUpload(remoteName, data)));
  }

  async remove(object: RemoteObject): Promise<void> {
    this.namespace.assertObject(object);
    const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(object.id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Google Drive delete failed (${response.status}).`);
    }
  }
}
