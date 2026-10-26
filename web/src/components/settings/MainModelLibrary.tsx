'use client';
import { isProviderEnabled } from '@/providers/providerPolicy';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, RefreshCw, X } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { modelCatalogRequestKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { listSwitchableModels, sortProviderAccounts } from '@/store/providerSelectors';
import { mainModelCompatible } from '@/lib/modelMeta';
import { isDedicatedImageModelId } from '@/providers/images';
import { getAdapter, resolveBaseUrl } from '@/providers/registry';
import { friendlyErrorMessage } from '@/providers/errors';
import { searchModelChoices } from '@/lib/fuzzyModels';
import { refreshOpenRouterRouteMetadata } from '@/lib/openRouterRouting';
import { ModelMetaBadges } from '../ModelMetaBadges';
import { ModelProviderFilter } from './ModelProviderFilter';
import { providerLabel } from './providerLabel';
import { SelectedModelDetails } from './SelectedModelDetails';
import { ModelCompatibilityOverride } from './ModelCompatibilityOverride';

export function MainModelLibrary() {
  const providers = useSettingsStore((state) => state.providers);
  const order = useSettingsStore((state) => state.mainModelOrder);
  const active = useSettingsStore((state) => state.activeModelRef);
  const setEnabled = useSettingsStore((state) => state.setEnabledModels);
  const setOrder = useSettingsStore((state) => state.setMainModelOrder);
  const showAll = useSettingsStore(state => state.modelCompatibilityOverrides?.main === true);
  const catalog = useModelCatalogStore((state) => state.catalog);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  // Selection changes must not refetch catalogs. Only connection changes do.
  const connectionKey = providers
    .map((provider) => `${provider.id}:${modelCatalogRequestKey(provider)}`)
    .join('|');
  useEffect(() => {
    let cancelled = false;
    const connected = useSettingsStore.getState().providers.filter((provider) => isProviderEnabled(provider.preset) && provider.apiKey.trim());
    setLoading(connected.length > 0);
    setErrors([]);
    void Promise.all(
      connected.map(async (provider) => {
        try {
          await useModelCatalogStore
            .getState()
            .refreshCatalog(
              provider.id,
              modelCatalogRequestKey(provider),
              () =>
                getAdapter(provider.preset).listModels(
                  provider.apiKey,
                  resolveBaseUrl(provider.preset, provider.baseUrl),
                ),
              { force: reload > 0 },
            );
          if (!cancelled) void refreshOpenRouterRouteMetadata(provider, provider.enabledModels);
        } catch (error) {
          if (!cancelled)
            setErrors((messages) => [
              ...messages,
              `${providerLabel(provider.preset, provider.name)}: ${friendlyErrorMessage(error)}`,
            ]);
        }
      }),
    ).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [connectionKey, reload]);

  const selected = listSwitchableModels({ providers, mainModelOrder: order });
  const connected = sortProviderAccounts(providers).filter((provider) => isProviderEnabled(provider.preset) && provider.apiKey.trim());
  const choices = useMemo(
    () =>
      sortProviderAccounts(providers)
        .filter((provider) => isProviderEnabled(provider.preset) && provider.apiKey.trim())
        .flatMap((provider) =>
          (catalog[provider.id] ?? [])
            .filter(
              (model) =>
                showAll || (mainModelCompatible(provider.preset, model.id, model, provider.webSearchEndpoint, provider.serverSearch) && !isDedicatedImageModelId(model.id)),
            )
            .map((info) => ({ provider, info })),
        ),
    [providers, catalog, showAll],
  );
  const filtered = searchModelChoices(
    choices.filter(({ provider }) => !providerFilter || provider.id === providerFilter),
    query,
    ({ provider, info }) => ({ provider: providerLabel(provider.preset, provider.name), id: info.id, name: info.name }),
  );
  const move = (index: number, direction: -1 | 1) => {
    const next = [...selected];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setOrder(next);
  };
  return (
    <div>
      <p className="field-help">
        Choose <strong>several main models</strong> for nodes and conversations.
        Switch models in the canvas picker or with <strong>Ctrl/⌘+M</strong>.
        Add <strong>Shift</strong> to cycle backwards.
      </p>
      <p className="field-help">
        <strong>Vision</strong> lets models read image context. <strong>Web search</strong> lets them find sources.
        Both are required by the default main and secondary filters.
        Main models also need <strong>tool calling</strong> for chat actions.
        Search runs only when enabled for the request.
      </p>
      <div className="settings-inline-heading">
        <h4>Your main models</h4>
        <span>{selected.length} selected · reorder below</span>
      </div>
      <ol className="settings-selected-models" aria-label="Selected main models">
        {selected.map((ref, index) => {
          const provider = providers.find((p) => p.id === ref.providerId)!;
          const compatible = mainModelCompatible(
            provider.preset,
            ref.model,
            catalog[provider.id]?.find((info) => info.id === ref.model),
            provider.webSearchEndpoint,
            provider.serverSearch,
          );
          return (
            <li key={`${ref.providerId}:${ref.model}`} className="settings-selected-model">
              <span className="settings-model-position">{index + 1}</span>
              <div className="settings-model-identity">
                <strong>{ref.model}</strong>
                <small>
                  {providerLabel(ref.preset, provider.name)}
                  {active?.providerId === ref.providerId && active.model === ref.model ? ' · Current' : ''}
                </small>
                {!provider.apiKey.trim() ? (
                  <small>API key needed</small>
                ) : (
                  !compatible && <small>Saved choice · required capabilities not confirmed</small>
                )}
                <SelectedModelDetails providerId={ref.providerId} preset={ref.preset} model={ref.model} />
              </div>
              <div className="settings-model-actions">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={index === 0}
                  aria-label={`Move ${ref.model} up`}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={index === selected.length - 1}
                  aria-label={`Move ${ref.model} down`}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${ref.model} from main models`}
                  onClick={() =>
                    setEnabled(
                      provider.id,
                      provider.enabledModels.filter((id) => id !== ref.model),
                    )
                  }
                >
                  <X size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      {!selected.length && (
        <p className="field-help">No main models selected. Add one or more from the catalog below.</p>
      )}
      <div className="settings-catalog-toolbar">
        <input
          type="search"
          className="input"
          aria-label="Filter main models"
          placeholder="Search models across all providers…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ModelProviderFilter
          providers={connected}
          value={providerFilter}
          onChange={setProviderFilter}
          label="Main model provider"
        />
        <button
          type="button"
          className="icon-btn"
          aria-label="Refresh main models"
          disabled={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
        </button>
      </div>
      {errors.map((error) => (
        <p key={error} className="settings-inline-error" role="alert">
          {error} Saved selections are kept.
        </p>
      ))}
      {loading && (
        <p className="field-help" role="status">
          Refreshing model catalogs…
        </p>
      )}
      <ul className="sc-model-list settings-main-model-list" aria-label="Available main models">
        {filtered.map(({ provider, info }) => {
          const on = provider.enabledModels.includes(info.id);
          return (
            <li key={`${provider.id}:${info.id}`}>
              <button
                type="button"
                className={`sc-model-item${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => {
                  setEnabled(
                    provider.id,
                    on
                      ? provider.enabledModels.filter((id) => id !== info.id)
                      : [...provider.enabledModels, info.id],
                  );
                  if (!on) {
                    setOrder([...selected, { providerId: provider.id, model: info.id }]);
                    if (!useSettingsStore.getState().activeModelRef)
                      useSettingsStore.getState().setActiveModel(provider.id, info.id);
                    void refreshOpenRouterRouteMetadata(provider, [info.id]);
                  }
                }}
              >
                <span className="sc-model-check">{on ? <Check size={12} /> : <Plus size={12} />}</span>
                <span className="settings-model-identity">
                  <span className="sc-model-name">{info.id}</span>
                  <small>{providerLabel(provider.preset, provider.name)}</small>
                </span>
                <ModelMetaBadges providerId={provider.id} preset={provider.preset} model={info.id} />
              </button>
            </li>
          );
        })}
      </ul>
      <ModelCompatibilityOverride role="main" />
      {!loading && !filtered.length && (
        <p className="field-help">
          {showAll ? 'No models match. Adjust the search or refresh the provider catalog.' : query || providerFilter
            ? 'No compatible models match this filter.'
            : 'No compatible models available. Connect a provider or refresh its catalog.'}
        </p>
      )}
    </div>
  );
}
