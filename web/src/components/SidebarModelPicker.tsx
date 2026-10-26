'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronsUpDown, Globe } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { modelCatalogRequestKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { listSwitchableModels, getActiveProvider, providerAccountLabel } from '@/store/providerSelectors';
import type { ProviderAccount } from '@/store/types';
import { modelSupportsWebSearch, webSearchUnavailableHint, getAdapter, resolveBaseUrl } from '@/providers/registry';
import { ModelMetaBadges } from '@/components/ModelMetaBadges';
import { useGraphStore } from '@/store/useGraphStore';
import { effectiveSourceMode, sourceLibrary } from '@/lib/projectSources';
import { refreshOpenRouterRouteMetadata } from '@/lib/openRouterRouting';
import { mainModelCompatible } from '@/lib/modelMeta';
import { modelDisplayName } from '@/lib/modelDisplay';
import { ReasoningControl } from './ReasoningControl';
import { LanguageControl } from './LanguageControl';

interface Props {
  /** 'up' (default) opens the dropdown above the trigger — for the sidebar,
   *  which sits at the bottom. 'down' opens below — for the top-right toolbar. */
  placement?: 'up' | 'down';
  /** 'toolbar' styles the trigger as a standalone glass pill (top-right);
   *  'sidebar' (default) is the inline bordered section. */
  variant?: 'sidebar' | 'toolbar';
  onReasoningOpenChange?: (open: boolean) => void;
}

/**
 * Active-model switcher. In the sidebar it sits just above the shortcut hints
 * and opens upward; in the canvas top-right toolbar (when the sidebar is
 * collapsed) it's a glass pill that opens downward. Lists every model the user
 * exposed across all connected providers (grouped by provider) and switches the
 * active one. The same switch is bound to Ctrl/⌘+M (cycle) in the global
 * keydown handler.
 */
export function SidebarModelPicker({ placement = 'up', variant = 'sidebar', onReasoningOpenChange }: Props = {}) {
  const providers = useSettingsStore((s) => s.providers);
  const mainModelOrder = useSettingsStore((s) => s.mainModelOrder);
  const activeModelRef = useSettingsStore((s) => s.activeModelRef);
  const showAll = useSettingsStore(s => s.modelCompatibilityOverrides?.main === true);
  const setActiveModel = useSettingsStore((s) => s.setActiveModel);
  const webSearch = useSettingsStore((s) => s.webSearch);
  const setWebSearch = useSettingsStore((s) => s.setWebSearch);
  const reasoning = useSettingsStore((s) => s.reasoningEffort);
  const setReasoning = useSettingsStore((s) => s.setReasoningEffort);
  const sourcesOnly = useGraphStore((s) => effectiveSourceMode(sourceLibrary(s.project)) === 'only');

  const [open, setOpen] = useState(false);
  const catalog = useModelCatalogStore((state) => state.catalog);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // On open, backfill the metadata catalog for any provider we haven't fetched
  // yet, so rows can show price/context/capability badges (no-op once cached).
  useEffect(() => {
    if (!open) return;
    for (const p of providers) {
      if (!p.apiKey.trim() || p.enabledModels.length === 0) continue;
      const catalog = useModelCatalogStore.getState();
      void catalog.refreshCatalog(
        p.id,
        modelCatalogRequestKey(p),
        () => getAdapter(p.preset).listModels(p.apiKey, resolveBaseUrl(p.preset, p.baseUrl)),
      ).catch(() => {});
      void refreshOpenRouterRouteMetadata(p, p.enabledModels);
    }
  }, [open, providers]);

  const models = listSwitchableModels({ providers, mainModelOrder });
  if (models.length === 0) return null;

  const activeLabel = activeModelRef?.model ? modelDisplayName(activeModelRef.model) : 'Pick a model';
  // Contiguous provider sections preserve the user's cross-provider order.
  const groups: Array<ProviderAccount & { orderedModels: string[] }> = [];
  for (const ref of models) {
    const previous = groups[groups.length - 1];
    if (previous?.id === ref.providerId) previous.orderedModels.push(ref.model);
    else {
      const provider = providers.find((p) => p.id === ref.providerId);
      if (provider) groups.push({ ...provider, orderedModels: [ref.model] });
    }
  }

  const activeProvider = getActiveProvider({ providers, activeModelRef });
  const activePreset = activeProvider?.preset;
  const searchSupported = !sourcesOnly && !!activeProvider && modelSupportsWebSearch(activeProvider.preset, activeModelRef?.model,
    catalog[activeProvider.id]?.find((info) => info.id === activeModelRef?.model), activeProvider.webSearchEndpoint, activeProvider.serverSearch, showAll);
  const searchOn = searchSupported && webSearch;

  return (
    <div
      className={'sc-modelpicker' + (variant === 'toolbar' ? ' sc-modelpicker--toolbar' : '')}
      ref={ref}
    >
      <div className="sc-modelpicker-row">
        <button
          type="button"
          className="sc-modelpicker-btn"
          onClick={() => setOpen((o) => !o)}
          data-tip="Switch the active model — Ctrl/⌘+M to cycle"
          title={activeModelRef?.model}
        >
          <span className="sc-modelpicker-label">{activeLabel}</span>
          <ChevronsUpDown viewBox="6 0 12 24" width={8} height={16} />
        </button>
        <LanguageControl placement={placement === 'down' ? 'below' : 'side'} onOpen={() => setOpen(false)} onOpenChange={onReasoningOpenChange} />
        <ReasoningControl modelRef={activeModelRef} value={reasoning} onChange={setReasoning} onOpen={() => setOpen(false)}
          onOpenChange={onReasoningOpenChange} placement={placement === 'down' ? 'below' : 'side'} />
        <button
          type="button"
          className={'sc-modelpicker-websearch' + (searchOn ? ' active' : '')}
          disabled={!searchSupported}
          aria-pressed={searchOn}
          onClick={() => setWebSearch(!webSearch)}
          data-tip={sourcesOnly
            ? 'Web search is unavailable in Sources only mode.'
            : searchSupported
            ? `Allow web search: ${searchOn ? 'ON' : 'OFF'}`
            : (activePreset ? webSearchUnavailableHint(activePreset) : 'Pick a model to enable web search')}
          aria-label="Allow web search for generation"
        >
          <Globe size={16} />
        </button>
      </div>

      {open && (
        <div
          className={'sc-modelpicker-pop' + (placement === 'down' ? ' sc-modelpicker-pop--down' : '')}
        >
          {groups.map((p, index) => (
            <div key={`${p.id}:${index}`} className="sc-modelpicker-group">
              <div className="sc-modelpicker-group-head">{providerAccountLabel(p)}</div>
              {p.orderedModels.filter((m) => showAll || mainModelCompatible(p.preset, m, catalog[p.id]?.find((info) => info.id === m), p.webSearchEndpoint, p.serverSearch)
                || (activeModelRef?.providerId === p.id && activeModelRef.model === m)).map((m) => {
                const isActive = activeModelRef?.providerId === p.id && activeModelRef.model === m;
                const compatible = mainModelCompatible(p.preset, m, catalog[p.id]?.find((info) => info.id === m), p.webSearchEndpoint, p.serverSearch);
                return (
                  <button
                    key={m}
                    type="button"
                    className={`sc-modelpicker-item${isActive ? ' active' : ''}`}
                    disabled={!compatible && !showAll}
                    data-tip={!compatible ? showAll ? 'Compatibility override enabled — required capabilities are not confirmed.' : 'Saved selection — choose a model with vision, web search, and tool calling for chat.' : undefined}
                    onClick={() => { setActiveModel(p.id, m); setOpen(false); }}
                  >
                    <span className="sc-modelpicker-item-id" title={m}>{modelDisplayName(m)}</span>
                    <ModelMetaBadges providerId={p.id} preset={p.preset} model={m} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
