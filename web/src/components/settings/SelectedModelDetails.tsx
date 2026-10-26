'use client';

import { Brain, Eye, Globe, Wrench } from 'lucide-react';
import type { ProviderPreset } from '@/store/types';
import { textEndpointKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { formatContext, formatPricePerM, modelPricingForRouting, resolveCaps } from '@/lib/modelMeta';
import { modelSupportsWebSearch } from '@/providers/registry';

/** Explicit properties for saved choices; catalog rows keep their compact badges. */
export function SelectedModelDetails({ providerId, preset, model }: { providerId: string; preset: ProviderPreset; model: string }) {
  const info = useModelCatalogStore((s) => s.catalog[providerId]?.find((item) => item.id === model));
  const endpoints = useModelCatalogStore((s) => s.endpoints[textEndpointKey(providerId, model)]);
  const routing = useSettingsStore((s) => s.openRouterRouting);
  const searchEndpoint = useSettingsStore((s) => s.providers.find((provider) => provider.id === providerId)?.webSearchEndpoint);
  const serverSearch = useSettingsStore((s) => s.providers.find((provider) => provider.id === providerId)?.serverSearch);
  const pricing = preset === 'openrouter' ? modelPricingForRouting(info, endpoints, routing).pricing : info?.pricing;
  const input = formatPricePerM(pricing?.inputPerM);
  const output = formatPricePerM(pricing?.outputPerM);
  const caps = resolveCaps(preset, model, info);
  return (
    <div className="settings-selected-properties">
      <dl>
        <div><dt>Cost:</dt><dd>{input || output ? <>
          {input && `${input} input`}{input && output ? ' · ' : ''}{output && `${output} output`}
          <small>Per million tokens, not per message. Input, output and any search charges are billed separately.</small>
        </> : 'Not reported by this provider'}</dd></div>
        <div><dt>Context length:</dt><dd>{formatContext(info?.contextLength) ? `${formatContext(info?.contextLength)} tokens` : 'Not reported by this provider'}</dd></div>
      </dl>
      <div className="settings-selected-capabilities">
        {caps.reasoning && <span><Brain size={14} /> Reasoning model</span>}
        {caps.vision && <span><Eye size={14} /> Understands images</span>}
        {modelSupportsWebSearch(preset, model, info, searchEndpoint, serverSearch) && <span><Globe size={14} /> Web search</span>}
        {caps.tools && <span><Wrench size={14} /> Tool calling</span>}
      </div>
    </div>
  );
}
