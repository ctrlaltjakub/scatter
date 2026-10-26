'use client';
import { Globe, Brain, Eye } from 'lucide-react';
import { textEndpointKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { modelSupportsWebSearch } from '@/providers/registry';
import { resolveCaps, formatContext, formatPricePerM, modelPricingForRouting } from '@/lib/modelMeta';
import type { ProviderPreset } from '@/store/types';

interface Props {
  providerId: string;
  preset: ProviderPreset;
  model: string;
}

/**
 * Compact metadata badges for one model row: output price, context window, and
 * capability icons (web search / reasoning / vision). Reads the session catalog
 * (populated on connect / in Settings / lazily by the picker) and shows only
 * what's known — renders nothing when there's no metadata at all, so id-only
 * providers (bare OpenAI/local) degrade to just the model name.
 */
export function ModelMetaBadges({ providerId, preset, model }: Props) {
  const info = useModelCatalogStore((s) => s.catalog[providerId]?.find((m) => m.id === model));
  const endpoints = useModelCatalogStore((s) => s.endpoints[textEndpointKey(providerId, model)]);
  const routing = useSettingsStore((s) => s.openRouterRouting);
  const searchEndpoint = useSettingsStore((s) => s.providers.find((provider) => provider.id === providerId)?.webSearchEndpoint);
  const serverSearch = useSettingsStore((s) => s.providers.find((provider) => provider.id === providerId)?.serverSearch);
  const caps = resolveCaps(preset, model, info);
  const ctx = formatContext(info?.contextLength);
  const routed = preset === 'openrouter'
    ? modelPricingForRouting(info, endpoints, routing)
    : { pricing: info?.pricing, endpoint: undefined };
  const price = formatPricePerM(routed.pricing?.outputPerM);
  const web = modelSupportsWebSearch(preset, model, info, searchEndpoint, serverSearch);
  const priceTip = preset === 'openrouter'
    ? `${routing === 'fast-start' ? 'Fast-start' : 'Cheapest-provider'} estimated output price per 1M tokens${routed.endpoint ? ` — currently ${routed.endpoint.providerName}` : ''}. OpenRouter may change the provider as live conditions change.`
    : 'Output price per 1M tokens';

  if (!ctx && !price && !caps.reasoning && !caps.vision && !web) return null;

  return (
    <span className="sc-model-badges">
      {price && <span className="sc-model-badge" data-tip={priceTip}>{price}</span>}
      {ctx && <span className="sc-model-badge" data-tip="Context window (tokens)">{ctx}</span>}
      {web && (
        <span className="sc-model-badge sc-model-badge--icon" data-tip="Web search available" aria-label="Web search">
          <Globe size={11} />
        </span>
      )}
      {caps.reasoning && (
        <span className="sc-model-badge sc-model-badge--icon" data-tip="Reasoning model" aria-label="Reasoning">
          <Brain size={11} />
        </span>
      )}
      {caps.vision && (
        <span className="sc-model-badge sc-model-badge--icon" data-tip="Accepts images" aria-label="Vision">
          <Eye size={11} />
        </span>
      )}
    </span>
  );
}
