'use client';

import type { ProviderAccount } from '@/store/types';
import { providerLabel } from './providerLabel';

export function ModelProviderFilter({
  providers,
  value,
  onChange,
  label,
}: {
  providers: ProviderAccount[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  if (providers.length < 2) return null;
  return (
    <select
      className="input settings-model-provider-filter"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">All providers</option>
      {providers.map((provider) => (
        <option key={provider.id} value={provider.id}>
          {providerLabel(provider.preset, provider.name)}
          {!provider.name && providers.filter((account) => account.preset === provider.preset).length > 1
            ? ` · ${provider.id.slice(0, 6)}`
            : ''}
        </option>
      ))}
    </select>
  );
}
