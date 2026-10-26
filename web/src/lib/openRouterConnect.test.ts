import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const key = 'scatter.openrouter.authorization';
beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  history.replaceState(null, '', '/connect/openrouter?code=one-time&state=test-state');
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ key: 'test-api-key' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { limit: null } }))));
});
afterEach(() => { vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

describe('OpenRouter authorization callback', () => {
  it('verifies and exchanges a single-use code exactly once, even for simultaneous callers', async () => {
    sessionStorage.setItem(key, JSON.stringify({ state: 'test-state', verifier: 'private-verifier', createdAt: Date.now() }));
    const { completeOpenRouterConnection } = await import('./openRouterConnect');
    const a = completeOpenRouterConnection();
    const b = completeOpenRouterConnection();
    expect(a).toBe(b);
    expect(await a).toBe('test-api-key');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://openrouter.ai/api/v1/auth/keys', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ code: 'one-time', code_verifier: 'private-verifier', code_challenge_method: 'S256' }),
    }));
    expect(location.search).toBe('');
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it.each(['missing', 'malformed', 'expired', 'future', 'wrong-state', 'cancelled'])('rejects %s authorization before making any request', async failure => {
    if (failure === 'malformed') sessionStorage.setItem(key, 'not-json');
    else if (failure !== 'missing') sessionStorage.setItem(key, JSON.stringify({
      state: failure === 'wrong-state' ? 'wrong' : 'test-state', verifier: 'secret',
      createdAt: Date.now() + (failure === 'expired' ? -610_000 : failure === 'future' ? 600_000 : 0),
    }));
    if (failure === 'cancelled') history.replaceState(null, '', '/connect/openrouter?state=test-state');
    const { completeOpenRouterConnection } = await import('./openRouterConnect');
    await expect(completeOpenRouterConnection()).rejects.toThrow('expired or could not be verified');
    expect(fetch).not.toHaveBeenCalled();
    expect(location.search).toBe('');
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('does not surface malformed provider response bodies', async () => {
    sessionStorage.setItem(key, JSON.stringify({ state: 'test-state', verifier: 'private', createdAt: Date.now() }));
    vi.mocked(fetch).mockReset().mockResolvedValue(new Response('not-json'));
    const { completeOpenRouterConnection } = await import('./openRouterConnect');
    await expect(completeOpenRouterConnection()).rejects.toThrow('did not return an API key');
  });
});
