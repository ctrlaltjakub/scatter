'use client';

import { memo, useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import type { ImageModelInfo } from '@/providers/types';
import type { ProviderAccount } from '@/store/types';
import { getImageAdapter, resolveBaseUrl } from '@/providers/registry';
import { modelCatalogRequestKey } from '@/store/useModelCatalogStore';
import { imagePricingKey, useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { compactImagePriceLabel, imagePricePresentation } from '@/lib/imagePricing';

/** Each visible row loads its own price without rebuilding the whole catalog. */
export const ImageModelOption = memo(function ImageModelOption({
  model,
  provider,
  selected,
  allowUnverified = false,
  imageCatalogEntry = true,
}: {
  model: ImageModelInfo;
  provider: ProviderAccount;
  selected: boolean;
  allowUnverified?: boolean;
  imageCatalogEntry?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const setModel = useSettingsStore((state) => state.setImageModel);
  const cachedPrice = useImageModelCatalogStore(
    (state) => state.pricing[imagePricingKey(provider.id, model.id)],
  );
  const pricing = model.pricing ?? cachedPrice;
  useEffect(() => {
    if (!imageCatalogEntry || model.pricing?.length) return;
    const adapter = getImageAdapter(provider.preset);
    if (!adapter?.listPricing) return;
    const load = () => {
      void useImageModelCatalogStore
        .getState()
        .refreshPricing(provider.id, model.id, `${modelCatalogRequestKey(provider)}\0${model.id}`, () =>
          adapter.listPricing!(provider.apiKey, model.id, resolveBaseUrl(provider.preset, provider.baseUrl)),
        )
        .catch(() => {});
    };
    if (selected || typeof IntersectionObserver === 'undefined') {
      load();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          load();
          observer.disconnect();
        }
      },
      { root: button.current?.closest('.sc-image-model-list'), rootMargin: '60px' },
    );
    if (button.current) observer.observe(button.current);
    return () => observer.disconnect();
  }, [model.id, model.pricing, provider, selected, imageCatalogEntry]);
  const priceLabel = compactImagePriceLabel(pricing);
  const rowPrice = imagePricePresentation(pricing, {});
  const suffix = `${provider.id}-${model.id}`;
  return (
    <li>
      <button
        ref={button}
        type="button"
        role="option"
        aria-label={model.id}
        aria-describedby={`sc-image-cap-${suffix}${priceLabel ? ` sc-image-price-${suffix}` : ''}`}
        aria-selected={selected}
        disabled={(!allowUnverified && model.supportsImageEditing !== true) || !getImageAdapter(provider.preset)?.edit}
        className={`sc-model-item${selected ? ' on' : ''}`}
        onClick={() => setModel(provider.id, model.id)}
      >
        <span className="sc-model-check">{selected && <Check size={12} />}</span>
        <span className="sc-model-name" title={model.id}>
          {model.id}
        </span>
        <span className="sc-image-model-meta">
          {priceLabel && (
            <span
              id={`sc-image-price-${suffix}`}
              className="sc-model-badge sc-image-model-price"
              data-tip={rowPrice.tooltip}
            >
              {priceLabel}
            </span>
          )}
          <span id={`sc-image-cap-${suffix}`} className="sc-image-model-cap">
            {model.supportsImageEditing ? 'Image editing' : imageCatalogEntry ? 'Editing unconfirmed' : 'Image support unconfirmed'}
          </span>
        </span>
      </button>
    </li>
  );
});
