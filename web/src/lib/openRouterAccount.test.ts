import { webcrypto, createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanApiKey, openRouterKeyLinks, readOpenRouterAccount } from './openRouterAccount';
afterEach(() => vi.unstubAllGlobals());
describe('OpenRouter account data', () => {
  it('checks a pasted key without making a paid generation request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 4, usage: 6 } })));
    vi.stubGlobal('fetch', fetcher);
    expect(await readOpenRouterAccount('  test\nkey ')).toEqual({ limit: 10, limit_remaining: 4, usage: 6 });
    expect(fetcher).toHaveBeenCalledWith('https://openrouter.ai/api/v1/key', expect.objectContaining({ headers: { Authorization: 'Bearer testkey' } }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('distinguishes missing values from zero and no cap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { limit: null, usage_daily: 0, usage: 'wrong', free_model_daily_requests: { remaining: 0 } } }))));
    const result = await readOpenRouterAccount('test');
    expect(result.limit).toBeNull(); expect(result.limit_remaining).toBeUndefined(); expect(result.usage_daily).toBe(0);
    expect(result.usage).toBeUndefined(); expect(result.free_model_daily_requests?.remaining).toBe(0);
  });
  it('does not echo credentials or arbitrary provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-key echoed', { status: 401 })));
    await expect(readOpenRouterAccount('secret-key')).rejects.toThrow('could not authenticate');
  });
  it('handles empty or malformed responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    await expect(readOpenRouterAccount('test')).rejects.toThrow('incomplete account');
  });
  it('retains optional connection metadata without treating deprecated rate_limit as a live limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      expires_at: null, is_management_key: false, organization_id: null, workspace_id: 'workspace',
      allowed_data_regions: ['global', 'europe', 42], creator_user_id: 'creator', rate_limit: { requests: 1000 },
    } }))));
    expect(await readOpenRouterAccount('test')).toEqual({ expires_at: null, is_management_key: false,
      organization_id: null, workspace_id: 'workspace', allowed_data_regions: ['global', 'europe'], creator_user_id: 'creator' });
  });
  it('uses only a SHA256 hash in owner-only management links', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const hash = createHash('sha256').update('test-key').digest('hex');
    expect(await openRouterKeyLinks('test-key')).toEqual({ settings: `https://openrouter.ai/keys/${hash}`, activity: `https://openrouter.ai/logs?api_key_hash=${hash}` });
    expect(cleanApiKey('s k\u200Bor')).toBe('skor');
  });
});
