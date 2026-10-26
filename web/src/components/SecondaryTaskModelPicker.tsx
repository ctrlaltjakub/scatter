'use client';
import { isProviderEnabled } from '@/providers/providerPolicy';

import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { searchModelChoices } from '@/lib/fuzzyModels';
import { secondaryModelCompatible } from '@/lib/modelMeta';
import { getAdapter, getPreset, resolveBaseUrl } from '@/providers/registry';
import { compareCaseInsensitive, sortProviderAccounts } from '@/store/providerSelectors';
import { modelCatalogRequestKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { ModelMetaBadges } from '@/components/ModelMetaBadges';
import type { ProviderPreset } from '@/store/types';
import { ModelProviderFilter } from './settings/ModelProviderFilter';
import { providerLabel } from './settings/providerLabel';
import { SelectedModel } from './settings/SelectedModel';
import { ModelCompatibilityOverride } from './settings/ModelCompatibilityOverride';

interface Choice {
  providerId: string;
  preset: ProviderPreset;
  model: string;
  name?: string;
}

/** One vision-capable model for every quiet support pass. */
export function SecondaryTaskModelPicker({ settingsLayout = false }: { settingsLayout?: boolean } = {}) {
  const providers = useSettingsStore((state) => state.providers);
  const activeModelRef = useSettingsStore((state) => state.activeModelRef);
  const secondaryModelRef = useSettingsStore((state) => state.secondaryModelRef);
  const setModel = useSettingsStore((state) => state.setSecondaryModel);
  const clearModel = useSettingsStore((state) => state.clearSecondaryModel);
  const catalog = useModelCatalogStore((state) => state.catalog);
  const showAll = useSettingsStore(state => state.modelCompatibilityOverrides?.secondary === true);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [providerFilter, setProviderFilter] = useState('');

  const connected = useMemo(
    () => sortProviderAccounts(providers).filter((provider) => isProviderEnabled(provider.preset) && provider.apiKey.trim()),
    [providers],
  );
  const signature = useMemo(
    () => connected.map((provider) => `${provider.id}:${modelCatalogRequestKey(provider)}`).join('|'),
    [connected],
  );

  useEffect(() => {
    if (!connected.length) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all(
      connected.map((provider) =>
        useModelCatalogStore
          .getState()
          .refreshCatalog(provider.id, modelCatalogRequestKey(provider), () =>
            getAdapter(provider.preset).listModels(
              provider.apiKey,
              resolveBaseUrl(provider.preset, provider.baseUrl),
            ),
          ),
      ),
    )
      .catch(() => {
        // A generic or temporarily unavailable provider can still use enabled IDs.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, signature]);

  const choices = useMemo(
    () =>
      connected
        .flatMap((provider) => {
          const byId = new Map((catalog[provider.id] ?? []).map((info) => [info.id, info]));
          for (const id of provider.enabledModels) if (!byId.has(id)) byId.set(id, { id });
          return [...byId.values()]
            .filter((info) => showAll || secondaryModelCompatible(provider.preset, info.id, info, provider.webSearchEndpoint, provider.serverSearch))
            .map(
              (info): Choice => ({
                providerId: provider.id,
                preset: provider.preset,
                model: info.id,
                name: info.name,
              }),
            );
        })
        .sort(
          (a, b) =>
            compareCaseInsensitive(getPreset(a.preset).label, getPreset(b.preset).label) ||
            compareCaseInsensitive(a.model, b.model),
        ),
    [catalog, connected, showAll],
  );
  const filtered = useMemo(
    () =>
      searchModelChoices(
        choices.filter((choice) => !providerFilter || choice.providerId === providerFilter),
        filter,
        (choice) => ({
          provider: getPreset(choice.preset).label,
          id: choice.model,
          name: choice.name,
        }),
      ),
    [choices, filter, providerFilter],
  );
  const selectedDedicatedIsVisible =
    !!secondaryModelRef &&
    choices.some(
      (choice) =>
        choice.providerId === secondaryModelRef.providerId && choice.model === secondaryModelRef.model,
    );

  return (
    <div className="sc-secondary-model-picker">
      {!settingsLayout && (
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Secondary tasks model</div>
      )}
      <p className="field-help" style={{ marginTop: 0, marginBottom: 8 }}>
        Choose <strong>one model</strong> for term marking, previews, titles, source assistance, and free-image discovery.{' '}
        The default filter requires <strong>vision and web search</strong> to read image sources and find references.
        Without a dedicated choice, these tasks use the <strong>main model</strong>.
      </p>
      <p className="field-help">Reasoning is fixed at <strong>Low</strong> when supported. This limits <strong>latency and cost</strong> for background tasks.</p>
      {settingsLayout && (
        <SelectedModel
          selected={secondaryModelRef}
          providers={providers}
          onRemove={clearModel}
          role="secondary"
          fallback="Use main model"
          fallbackRef={activeModelRef}
        />
      )}
      <div className={settingsLayout ? 'settings-catalog-toolbar' : undefined}>
        <input
          className="input"
          type="search"
          aria-label="Filter secondary task models"
          placeholder="Filter secondary models…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {settingsLayout && (
          <ModelProviderFilter
            providers={connected}
            value={providerFilter}
            onChange={setProviderFilter}
            label="Secondary model provider"
          />
        )}
      </div>
      <div className="sc-image-model-list" role="listbox" aria-label="Secondary tasks model">
        {connected.map((provider) => {
          const providerChoices = filtered.filter((choice) => choice.providerId === provider.id);
          if (!providerChoices.length) return null;
          return (
            <div className="sc-image-model-group" key={provider.id}>
              <div className="welcome-model-group-head">
                <span>
                  {providerLabel(provider.preset, provider.name)}
                </span>
                <span>
                  {providerChoices.length} model{providerChoices.length === 1 ? '' : 's'}
                </span>
              </div>
              <ul className="sc-model-list">
                {providerChoices.map((choice) => {
                  const selected =
                    secondaryModelRef?.providerId === choice.providerId &&
                    secondaryModelRef.model === choice.model;
                  return (
                    <li key={`${choice.providerId}:${choice.model}`}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`sc-model-item${selected ? ' on' : ''}`}
                        onClick={() => setModel(choice.providerId, choice.model)}
                      >
                        <span className="sc-model-check">{selected && <Check size={12} />}</span>
                        <span className="sc-model-name" title={choice.model}>
                          {choice.model}
                        </span>
                        <ModelMetaBadges
                          providerId={choice.providerId}
                          preset={choice.preset}
                          model={choice.model}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        {secondaryModelRef && !selectedDedicatedIsVisible && (
          <p className="field-help">
            {showAll ? 'The saved secondary model is not in the current catalog.'
              : 'The saved secondary model’s required capabilities could not be confirmed. Choose a compatible model or enable Show all models to use it at your own risk.'}
          </p>
        )}
        {!secondaryModelRef && (
          <p className="field-help">
            Choose a dedicated vision and web-search model, or leave this empty to use the main model.
          </p>
        )}
        {loading && choices.length === 0 && <p className="field-help">Loading models…</p>}
        {!loading && filtered.length === 0 && filter.trim() && (
          <p className="field-help">No {showAll ? '' : 'compatible '}models match “{filter.trim()}”.</p>
        )}
        {!loading && filtered.length === 0 && providerFilter && !filter.trim() && choices.length > 0 && (
          <p className="field-help">
            No {showAll ? '' : 'compatible '}models are available from this provider. Choose another provider.
          </p>
        )}
        {!loading && connected.length > 0 && choices.length === 0 && !filter.trim() && (
          <p className="field-help">{showAll ? 'No models are available from the connected providers.' : 'No connected model has confirmed vision and web-search support.'}</p>
        )}
        {!loading && connected.length === 0 && <p className="field-help">Connect a model provider first.</p>}
      </div>
      <ModelCompatibilityOverride role="secondary" />
    </div>
  );
}
