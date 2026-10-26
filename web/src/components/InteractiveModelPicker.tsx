'use client';
import { isProviderEnabled } from '@/providers/providerPolicy';

import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { searchModelChoices } from '@/lib/fuzzyModels';
import { interactiveModelCompatible } from '@/lib/modelMeta';
import { resolveInteractiveModel } from '@/lib/interactiveModel';
import { getAdapter, getPreset, resolveBaseUrl } from '@/providers/registry';
import { compareCaseInsensitive, sortProviderAccounts } from '@/store/providerSelectors';
import { modelCatalogRequestKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { ModelMetaBadges } from '@/components/ModelMetaBadges';
import type { ProviderPreset } from '@/store/types';
import { ModelProviderFilter } from './settings/ModelProviderFilter';
import { providerLabel } from './settings/providerLabel';
import { SelectedModel } from './settings/SelectedModel';
import { ReasoningControl } from './ReasoningControl';
import { ModelCompatibilityOverride } from './settings/ModelCompatibilityOverride';

interface Choice {
  providerId: string;
  preset: ProviderPreset;
  model: string;
  name?: string;
}

export function InteractiveModelPicker({ settingsLayout = false }: { settingsLayout?: boolean } = {}) {
  const providers = useSettingsStore((state) => state.providers);
  const activeModelRef = useSettingsStore((state) => state.activeModelRef);
  const interactiveModelRef = useSettingsStore((state) => state.interactiveModelRef);
  const setInteractiveModel = useSettingsStore((state) => state.setInteractiveModel);
  const setInteractiveModelAuto = useSettingsStore((state) => state.setInteractiveModelAuto);
  const effort = useSettingsStore((state) => state.interactiveReasoningEffort);
  const setEffort = useSettingsStore((state) => state.setInteractiveReasoningEffort);
  const catalog = useModelCatalogStore((state) => state.catalog);
  const showAll = useSettingsStore(state => state.modelCompatibilityOverrides?.interactive === true);
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
        // A provider may be offline or reject model listing. Other connected
        // catalogs and the configured fallback remain usable.
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
          // Keep already-enabled models available when a provider cannot expose a
          // catalog (common for generic OpenAI-compatible endpoints).
          for (const id of provider.enabledModels) {
            if (!byId.has(id)) byId.set(id, { id });
          }
          return [...byId.values()]
            .filter((info) => showAll || interactiveModelCompatible(provider.preset, info.id, info))
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

  const effective = resolveInteractiveModel({
    providers,
    activeModelRef,
    interactiveModelRef,
    catalog,
  });
  const reasoningToggle = effective.ref
    ? catalog[effective.ref.providerId]?.find(model => model.id === effective.ref!.model)?.reasoning?.mode === 'toggle'
    : false;
  const filtered = useMemo(() => {
    return searchModelChoices(
      choices.filter((choice) => !providerFilter || choice.providerId === providerFilter),
      filter,
      (choice) => ({
        provider: getPreset(choice.preset).label,
        id: choice.model,
        name: choice.name,
      }),
    );
  }, [choices, filter, providerFilter]);

  return (
    <div className="sc-interactive-model-picker">
      {!settingsLayout && (
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Interactive nodes model</div>
      )}
      <p className="field-help" style={{ marginTop: 0, marginBottom: 8 }}>
        Plans, codes, tests, and reviews <strong>interactive programs</strong>.
        {' '}<strong>Vision is required</strong> to review rendered screenshots; reliable tool calling is recommended.
        Without a dedicated choice, the app uses your <strong>main text model</strong>.
      </p>
      {effective.ref && !showAll && !interactiveModelCompatible(
        providers.find(provider => provider.id === effective.ref!.providerId)?.preset ?? 'custom',
        effective.ref.model, catalog[effective.ref.providerId]?.find(info => info.id === effective.ref!.model)) &&
        <p className="field-help" role="status">The selected model has no confirmed vision support. Choose a vision model, or use <strong>Show all models</strong> if its metadata is incomplete. Screenshot review is not skipped.</p>}
      {settingsLayout && (
        <>
          <p className="field-help">
            Choose <strong>one model</strong> for diagrams, simulations, and mini-apps.
            Removing it restores the <strong>main-model fallback</strong>.
          </p>
          <SelectedModel
            selected={interactiveModelRef}
            providers={providers}
            onRemove={setInteractiveModelAuto}
            role="interactive"
            fallback="Use main text model"
            fallbackRef={effective.ref}
          />
          <ReasoningControl inline modelRef={effective.ref} value={effort} onChange={setEffort} />
          <p className="field-help">{reasoningToggle
            ? <><strong>On</strong> is selected by default.</>
            : <><strong>High</strong> is recommended and selected by default.</>} This control affects <strong>interactive programs only</strong>.</p>
        </>
      )}
      <div className={settingsLayout ? 'settings-catalog-toolbar' : undefined}>
        <input
          className="input"
          type="search"
          aria-label="Filter interactive explanation models"
          placeholder="Filter interactive models…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {settingsLayout && (
          <ModelProviderFilter
            providers={connected}
            value={providerFilter}
            onChange={setProviderFilter}
            label="Interactive model provider"
          />
        )}
      </div>
      <div className="sc-image-model-list" role="listbox" aria-label="Interactive nodes model">
        {!filter.trim() && (
          <ul className="sc-model-list sc-image-model-none">
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!interactiveModelRef}
                className={`sc-model-item${!interactiveModelRef ? ' on' : ''}`}
                onClick={setInteractiveModelAuto}
              >
                <span className="sc-model-check">{!interactiveModelRef && <Check size={12} />}</span>
                <span className="sc-model-name">
                  Use main text model{activeModelRef ? ` — ${activeModelRef.model}` : ''}
                </span>
              </button>
            </li>
          </ul>
        )}
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
                    interactiveModelRef?.providerId === choice.providerId &&
                    interactiveModelRef.model === choice.model;
                  return (
                    <li key={`${choice.providerId}:${choice.model}`}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`sc-model-item${selected ? ' on' : ''}`}
                        onClick={() => setInteractiveModel(choice.providerId, choice.model)}
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
        {loading && choices.length === 0 && <p className="field-help">Loading models…</p>}
        {!loading && filtered.length === 0 && filter.trim() && (
          <p className="field-help">No {showAll ? '' : 'vision '}models match “{filter.trim()}”.</p>
        )}
        {!loading && filtered.length === 0 && providerFilter && !filter.trim() && (
          <p className="field-help">
            No {showAll ? '' : 'vision '}models are available from this provider. Choose another provider.
          </p>
        )}
        {!loading && connected.length === 0 && <p className="field-help">Connect a text provider first.</p>}
      </div>
      <ModelCompatibilityOverride role="interactive" />
    </div>
  );
}
