/** Account checks never generate text or spend credits. Keep credentials out of errors. */
export interface OpenRouterAccountInfo {
  label?: string;
  limit?: number | null;
  limit_reset?: string | null;
  limit_remaining?: number | null;
  usage?: number;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  byok_usage?: number;
  byok_usage_daily?: number;
  byok_usage_weekly?: number;
  byok_usage_monthly?: number;
  include_byok_in_limit?: boolean;
  is_free_tier?: boolean;
  expires_at?: string | null;
  is_management_key?: boolean;
  is_provisioning_key?: boolean;
  allowed_data_regions?: string[];
  creator_user_id?: string;
  organization_id?: string | null;
  workspace_id?: string | null;
  free_model_daily_requests?: { used?: number; limit?: number; remaining?: number };
}

export function cleanApiKey(key: string): string {
  return key.replace(/[\s\u0000-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, '');
}

export async function readOpenRouterAccount(key: string, signal?: AbortSignal): Promise<OpenRouterAccountInfo> {
  const response = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${cleanApiKey(key)}` },
    cache: 'no-store', signal,
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'OpenRouter could not authenticate this key. Check the key or connect again.'
    : `OpenRouter account information is unavailable (HTTP ${response.status}). Try again shortly.`);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('data' in body) || !body.data || typeof body.data !== 'object') {
    throw new Error('OpenRouter returned incomplete account information. Try again shortly.');
  }
  const raw = body.data as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const field of ['limit', 'limit_remaining', 'usage', 'usage_daily', 'usage_weekly', 'usage_monthly',
    'byok_usage', 'byok_usage_daily', 'byok_usage_weekly', 'byok_usage_monthly']) {
    const value = raw[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) data[field] = value;
    else if (value === null && (field === 'limit' || field === 'limit_remaining')) data[field] = null;
  }
  if (typeof raw.label === 'string') data.label = raw.label.slice(0, 200);
  if (typeof raw.limit_reset === 'string' || raw.limit_reset === null) data.limit_reset = raw.limit_reset;
  for (const field of ['include_byok_in_limit', 'is_free_tier', 'is_management_key', 'is_provisioning_key']) {
    if (typeof raw[field] === 'boolean') data[field] = raw[field];
  }
  for (const field of ['expires_at', 'creator_user_id', 'organization_id', 'workspace_id']) {
    if (typeof raw[field] === 'string') data[field] = raw[field].slice(0, 200);
    else if (raw[field] === null && field !== 'creator_user_id') data[field] = null;
  }
  if (Array.isArray(raw.allowed_data_regions)) data.allowed_data_regions = raw.allowed_data_regions
    .filter((value): value is string => typeof value === 'string').slice(0, 30).map(value => value.slice(0, 80));
  if (raw.free_model_daily_requests && typeof raw.free_model_daily_requests === 'object') {
    const counters: Record<string, number> = {};
    for (const field of ['used', 'limit', 'remaining']) {
      const value = (raw.free_model_daily_requests as Record<string, unknown>)[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) counters[field] = value;
    }
    data.free_model_daily_requests = counters;
  }
  return data as OpenRouterAccountInfo;
}

export async function openRouterKeyLinks(key: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cleanApiKey(key)));
  const hash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  return { settings: `https://openrouter.ai/keys/${hash}`, activity: `https://openrouter.ai/logs?api_key_hash=${hash}` };
}
