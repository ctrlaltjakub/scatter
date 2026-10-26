'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { openRouterKeyLinks, readOpenRouterAccount, type OpenRouterAccountInfo } from '@/lib/openRouterAccount';
import { SettingsSection } from './SettingsSection';
import { CollapsibleSection } from '../dev/CollapsibleSection';

const money = (value: number | null | undefined) => typeof value === 'number'
  ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value)
  : 'Not reported';
const expiry = (value: string | null | undefined) => value === null ? 'Does not expire'
  : value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not reported';

export function OpenRouterAccount() {
  const account = useSettingsStore(s => s.providers.find(p => p.preset === 'openrouter' && p.apiKey.trim()));
  const key = account?.apiKey ?? '';
  const [result, setResult] = useState<{ key: string; data: OpenRouterAccountInfo; checked: Date } | null>(null);
  const [links, setLinks] = useState<{ key: string; settings: string; activity: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let cancelled = false;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    setLoading(true);
    setError('');
    void readOpenRouterAccount(key, controller.signal).then(data => {
      if (!cancelled) setResult({ key, data, checked: new Date() });
    }).catch(() => {
      if (!cancelled) setError('Could not refresh OpenRouter account information. Check your connection and API key, then retry.');
    }).finally(() => {
      clearTimeout(timeout);
      if (!cancelled) setLoading(false);
    });
    void openRouterKeyLinks(key).then(value => {
      if (!cancelled) setLinks({ key, ...value });
    }).catch(() => undefined);
    return () => { cancelled = true; controller.abort(); clearTimeout(timeout); };
  }, [key, refresh]);
  const data = result?.key === key ? result.data : undefined;
  const currentLinks = links?.key === key ? links : null;
  if (!account) return <p className="field-help">Connect OpenRouter in <strong>AI providers</strong> to view usage and spending limits.</p>;
  return <div className="openrouter-account">
    <div className="settings-inline-heading">
      <div><strong>{data?.label || 'Your OpenRouter connection'}</strong>
        <p className="field-help">{result?.key === key ? `Updated ${result.checked.toLocaleTimeString()}` : 'Account information'}</p></div>
      <button className="btn btn-secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>
        <RefreshCw size={14} className={loading ? 'spin' : undefined} /> {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
    {error && <p role="alert" className="sync-settings-error">{error}{data ? ' Previously fetched figures are shown below.' : ''}</p>}
    <SettingsSection title="Spending allowance" description={<>This is the <strong>limit for this API key</strong>, not your account’s credit balance. A shared key includes usage from other apps and devices.</>}>
      <dl className="openrouter-metrics">
        <div><dt>Spending limit</dt><dd>{data?.limit === null ? 'No limit set' : money(data?.limit)}</dd></div>
        <div><dt>Remaining allowance</dt><dd>{data?.limit_remaining === null ? 'No key limit' : money(data?.limit_remaining)}</dd></div>
        <div><dt>Limit resets</dt><dd>{data?.limit_reset === null ? 'Does not reset' : data?.limit_reset || 'Not reported'}</dd></div>
      </dl>
      <p className="field-help"><strong>OpenRouter enforces your spending limit.</strong> Change it in OpenRouter and refresh here. Account credits may run out before this allowance.</p>
      <div className="sync-button-row">
        <a className="btn btn-secondary" href={currentLinks?.settings ?? 'https://openrouter.ai/keys'} target="_blank" rel="noopener noreferrer">Manage spending limit <ExternalLink size={13} /></a>
        <a className="btn btn-secondary" href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener noreferrer">Manage credits <ExternalLink size={13} /></a>
      </div>
      <p className="field-help">The <strong>full account balance</strong> requires a management key with broader permissions. The app does not request that access. View the balance and top-up options in OpenRouter.</p>
    </SettingsSection>
    <SettingsSection title="Usage" description={<>Amounts reported by OpenRouter for <strong>this key</strong>. Daily and weekly periods use UTC; weeks start on Monday.</>}>
      <dl className="openrouter-metrics">
        {([['Today', 'usage_daily'], ['This week', 'usage_weekly'], ['This month', 'usage_monthly'], ['All time', 'usage']] as const)
          .map(([label, field]) => <div key={field}><dt>{label}</dt><dd>{money(data?.[field])}</dd></div>)}
      </dl>
      <a className="btn btn-secondary" href={currentLinks?.activity ?? 'https://openrouter.ai/activity'} target="_blank" rel="noopener noreferrer">View activity <ExternalLink size={13} /></a>
    </SettingsSection>
    <SettingsSection title="Request allowance">
      <dl className="openrouter-metrics">
        <div><dt>Account tier</dt><dd>{data?.is_free_tier === undefined ? 'Not reported' : data.is_free_tier ? 'Free tier' : 'Paid credits purchased'}</dd></div>
        {(['used', 'limit', 'remaining'] as const).map(field => <div key={field}><dt>Free requests · {field}</dt><dd>{data?.free_model_daily_requests?.[field] ?? 'Not reported'}</dd></div>)}
      </dl>
      <p className="field-help"><strong>Free-model limits</strong> are separate from paid usage. Providers may also impose temporary request limits that are not reported here.</p>
    </SettingsSection>
    <div className="openrouter-details"><CollapsibleSection title="Usage with your own provider keys">
      <p className="field-help">If you connect a provider’s own key inside OpenRouter, that provider bills those requests. OpenRouter reports their usage separately.</p>
      <dl className="openrouter-metrics">
        {([['Today', 'byok_usage_daily'], ['This week', 'byok_usage_weekly'], ['This month', 'byok_usage_monthly'], ['All time', 'byok_usage']] as const)
          .map(([label, field]) => <div key={field}><dt>{label}</dt><dd>{money(data?.[field])}</dd></div>)}
      </dl>
      <p className="field-help">Included in this key’s spending limit: <strong>{data?.include_byok_in_limit === undefined ? 'Not reported' : data.include_byok_in_limit ? 'Yes' : 'No'}</strong>.</p>
    </CollapsibleSection></div>
    <div className="openrouter-details"><CollapsibleSection title="Connection details">
      <dl className="openrouter-metrics">
        <div><dt>Key expires</dt><dd>{expiry(data?.expires_at)}</dd></div>
        <div><dt>Key type</dt><dd>{data?.is_management_key || data?.is_provisioning_key ? 'Management key'
          : data?.is_management_key === false || data?.is_provisioning_key === false ? 'Standard API key' : 'Not reported'}</dd></div>
        <div><dt>Allowed data regions</dt><dd>{data?.allowed_data_regions?.join(', ') || 'Not reported'}</dd></div>
        <div><dt>Organization</dt><dd>{data?.organization_id === null ? 'Personal account' : data?.organization_id || 'Not reported'}</dd></div>
        <div><dt>Workspace ID</dt><dd>{data?.workspace_id ?? 'Not reported'}</dd></div>
        <div><dt>Creator ID</dt><dd>{data?.creator_user_id ?? 'Not reported'}</dd></div>
      </dl>
      {(data?.is_management_key || data?.is_provisioning_key) && <p className="field-help"><strong>This key has management permissions.</strong> Prefer a standard API key for the app; it does not need permission to manage your other keys.</p>}
    </CollapsibleSection></div>
  </div>;
}
