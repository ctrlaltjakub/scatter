import { cleanApiKey } from './openRouterAccount';
import { appPath } from './deployment';

const KEY = 'scatter.openrouter.authorization';
const MAX_AGE = 10 * 60 * 1000;
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Same-tab authorization avoids popup blockers and survives a browser refresh.
 * The verifier never leaves this tab except in the one-time code exchange. */
export async function beginOpenRouterConnection(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(KEY, JSON.stringify({ verifier, state, createdAt: Date.now() }));
  const callback = new URL(appPath('/connect/openrouter'), window.location.origin);
  callback.searchParams.set('state', state);
  const url = new URL('https://openrouter.ai/auth');
  url.search = new URLSearchParams({ callback_url: callback.href, code_challenge: challenge,
    code_challenge_method: 'S256', key_label: 'Scatter' }).toString();
  window.location.assign(url.href);
}

let exchange: Promise<string> | undefined;
/** React Strict Mode must not exchange a single-use authorization code twice. */
export function completeOpenRouterConnection(): Promise<string> {
  if (exchange) return exchange;
  exchange = (async () => {
    const url = new URL(window.location.href);
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { /* invalid or unavailable session */ }
    const code = url.searchParams.get('code');
    // Remove the short-lived code from the address bar before further navigation.
    history.replaceState(null, '', url.pathname);
    try { sessionStorage.removeItem(KEY); } catch { /* verification still fails closed */ }
    if (!saved || typeof saved.verifier !== 'string' || typeof saved.state !== 'string'
      || typeof saved.createdAt !== 'number' || Date.now() - saved.createdAt > MAX_AGE
      || Date.now() < saved.createdAt || saved.state !== url.searchParams.get('state') || !code) {
      throw new Error('This connection request expired or could not be verified. Return to setup and connect again.');
    }
    const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: saved.verifier, code_challenge_method: 'S256' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('OpenRouter could not complete authorization. Return to setup and connect again.');
    const body: unknown = await response.json().catch(() => null);
    const key = body && typeof body === 'object' && 'key' in body && typeof body.key === 'string' ? cleanApiKey(body.key) : '';
    if (!key) throw new Error('OpenRouter did not return an API key. Return to setup and connect again.');
    // Persist the returned key before checking account/catalog availability on
    // the review screen. A temporary outage must not lose a newly issued key.
    return key;
  })();
  return exchange;
}
