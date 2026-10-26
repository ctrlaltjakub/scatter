'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ActiveModelRef, ProviderAccount } from '@/store/types';
import { providerLabel } from './providerLabel';
import { SelectedModelDetails } from './SelectedModelDetails';

/** Always outside the searchable catalog, so filtering never hides a saved choice. */
export function SelectedModel({
  selected,
  providers,
  onRemove,
  role,
  fallback,
  fallbackRef,
  detail,
}: {
  selected?: ActiveModelRef | null;
  providers: ProviderAccount[];
  onRemove: () => void;
  role: string;
  fallback: string;
  fallbackRef?: ActiveModelRef | null;
  detail?: ReactNode;
}) {
  const displayedRef = selected ?? fallbackRef;
  const provider = providers.find((account) => account.id === displayedRef?.providerId);
  return (
    <div className="settings-selected-model" aria-label={`Selected ${role} model`}>
      <div className="settings-model-identity">
        <small>{selected ? 'Selected · one model' : 'No dedicated model'}</small>
        <strong>{selected?.model ?? fallback}</strong>
        {!selected && fallbackRef && <small>{fallbackRef.model}</small>}
        {provider && (
          <small>
            {providerLabel(provider.preset, provider.name)}
            {!provider.apiKey.trim() ? ' · API key needed' : ''}
          </small>
        )}
        {detail}
        {displayedRef && provider && role !== 'image' && <SelectedModelDetails providerId={provider.id} preset={provider.preset} model={displayedRef.model} />}
      </div>
      {selected && (
        <button
          type="button"
          className="icon-btn"
          aria-label={`Remove selected ${role} model`}
          title="Remove selection"
          onClick={onRemove}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}
