'use client';
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { getAdapter, getImageAdapter, getPreset, resolveBaseUrl } from '@/providers/registry';
import { friendlyErrorMessage } from '@/providers/errors';
import { fuzzyFilterModels, searchModelChoices } from '@/lib/fuzzyModels';
import { modelCatalogRequestKey, useModelCatalogStore } from '@/store/useModelCatalogStore';
import { imagePricingKey, useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { compareCaseInsensitive, sortProviderAccounts } from '@/store/providerSelectors';
import type { ImageModelInfo } from '@/providers/types';
import type { ProviderPreset } from '@/store/types';
import { validCustomImageSize } from '@/lib/imageGenerationSettings';
import { imagePricePresentation } from '@/lib/imagePricing';
import { ImageModelOption } from './settings/ImageModelOption';
import { ModelProviderFilter } from './settings/ModelProviderFilter';
import { providerLabel } from './settings/providerLabel';
import { SelectedModel } from './settings/SelectedModel';
import { directOpenAIImageModel, parseOpenRouterImageModel } from '@/providers/images';
import { ModelCompatibilityOverride } from './settings/ModelCompatibilityOverride';

interface Choice extends ImageModelInfo {
  providerId: string;
  preset: ProviderPreset;
  imageCatalogEntry: boolean;
}

function imageSizeLabel(size: string): string {
  if (size === 'auto') return 'Auto';
  if (size === 'custom') return 'Custom';
  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) return size;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const shape = width === height ? 'square' : width > height ? 'landscape' : 'portrait';
  return `${width} × ${height} — ${shape}`;
}

function titleCase(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function ImageModelPicker({
  providerId,
  settingsLayout = false,
}: { providerId?: string; settingsLayout?: boolean } = {}) {
  const providers = useSettingsStore((state) => state.providers);
  const imageModelRef = useSettingsStore((state) => state.imageModelRef);
  const settings = useSettingsStore((state) => state.imageGenerationSettings);
  const setImageModel = useSettingsStore((state) => state.setImageModel);
  const setImageModelNone = useSettingsStore((state) => state.setImageModelNone);
  const setSettings = useSettingsStore((state) => state.setImageGenerationSettings);
  const catalog = useImageModelCatalogStore((state) => state.catalog);
  const allCatalogs = useModelCatalogStore(state => state.catalog);
  const showAll = useSettingsStore(state => state.modelCompatibilityOverrides?.image === true);
  const selectedPricing = useImageModelCatalogStore((state) =>
    imageModelRef ? state.pricing[imagePricingKey(imageModelRef.providerId, imageModelRef.model)] : undefined,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [providerFilter, setProviderFilter] = useState('');

  const imageProviders = useMemo(
    () =>
      sortProviderAccounts(providers).filter(
        (provider) =>
          provider.apiKey.trim() &&
          !!getImageAdapter(provider.preset) &&
          (!providerId || provider.id === providerId),
      ),
    [providerId, providers],
  );
  const providerSignature = useMemo(
    () => imageProviders.map((provider) => `${provider.id}:${modelCatalogRequestKey(provider)}`).join('|'),
    [imageProviders],
  );

  useEffect(() => {
    let cancelled = false;
    if (!imageProviders.length) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void Promise.all(
      imageProviders.map((provider) => {
        const adapter = getImageAdapter(provider.preset)!;
        return useImageModelCatalogStore
          .getState()
          .refreshCatalog(provider.id, modelCatalogRequestKey(provider), () =>
            adapter.listModels(provider.apiKey, resolveBaseUrl(provider.preset, provider.baseUrl)),
          );
      }),
    )
      .catch((cause) => {
        if (!cancelled) setError(friendlyErrorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [imageProviders, providerSignature]);

  useEffect(() => {
    if (!showAll) return;
    // Some providers filter their image catalog by known model families. The
    // override also exposes their general catalog, without inventing controls
    // or an image transport for providers that the app does not support.
    for (const provider of imageProviders) {
      void useModelCatalogStore.getState().refreshCatalog(provider.id, modelCatalogRequestKey(provider),
        () => getAdapter(provider.preset).listModels(provider.apiKey, resolveBaseUrl(provider.preset, provider.baseUrl)))
        .catch(() => undefined); // The image catalog remains usable independently.
    }
  }, [showAll, imageProviders, providerSignature]);

  // Price metadata is deliberately independent from the model-list request.
  // OpenRouter exposes it per model endpoint, so queue it in the background
  // without delaying selection or the rest of the picker.
  useEffect(() => {
    for (const provider of imageProviders) {
      const adapter = getImageAdapter(provider.preset);
      if (!adapter?.listPricing) continue;
      // Fetch the selected price first; browsing the catalog must not queue
      // hundreds of endpoint requests ahead of the model being configured.
      for (const model of catalog[provider.id] ?? []) {
        if (provider.id !== imageModelRef?.providerId || model.id !== imageModelRef.model) continue;
        if (model.pricing?.length) continue;
        const requestKey = `${modelCatalogRequestKey(provider)}\0${model.id}`;
        void useImageModelCatalogStore
          .getState()
          .refreshPricing(provider.id, model.id, requestKey, () =>
            adapter.listPricing!(
              provider.apiKey,
              model.id,
              resolveBaseUrl(provider.preset, provider.baseUrl),
            ),
          )
          .catch(() => {
            // Missing price metadata must never make an otherwise usable model
            // look broken. The selected detail reports Price unavailable.
          });
      }
    }
  }, [catalog, imageProviders, providerSignature, imageModelRef]);

  const choices = useMemo(
    () =>
      imageProviders
        .flatMap((provider) => {
          const models = new Map<string, Choice>();
          if (showAll) for (const model of allCatalogs[provider.id] ?? []) {
            models.set(model.id, { id: model.id, name: model.name, providerId: provider.id,
              preset: provider.preset, imageCatalogEntry: false });
          }
          for (const model of catalog[provider.id] ?? []) {
            models.set(model.id, { ...model, providerId: provider.id,
              preset: provider.preset, imageCatalogEntry: true });
          }
          return [...models.values()];
        })
        .sort(
          (a, b) =>
            compareCaseInsensitive(getPreset(a.preset).label, getPreset(b.preset).label) ||
            compareCaseInsensitive(a.id, b.id),
        ),
    [catalog, allCatalogs, imageProviders, showAll],
  );
  const catalogSelection = choices.find(
    (choice) => choice.providerId === imageModelRef?.providerId && choice.id === imageModelRef.model,
  );
  // Known saved models need not wait for a fresh network catalog. Never infer
  // arbitrary providers' controls or copy direct-API pricing to a routed model.
  const knownSelection = useMemo((): Choice | undefined => {
    if (!imageModelRef) return;
    const provider = imageProviders.find((account) => account.id === imageModelRef.providerId);
    if (!provider) return;
    const info =
      provider.preset === 'openai'
        ? directOpenAIImageModel(imageModelRef.model)
        : provider.preset === 'openrouter' &&
            /^openai\//i.test(imageModelRef.model) &&
            directOpenAIImageModel(imageModelRef.model.replace(/^openai\//i, ''))
          ? parseOpenRouterImageModel({ id: imageModelRef.model })
          : null;
    return info ? { ...info, providerId: provider.id, preset: provider.preset, imageCatalogEntry: true } : undefined;
  }, [imageProviders, imageModelRef]);
  const selectedInfo = catalogSelection ?? knownSelection;
  const selected = selectedInfo
    ? { ...selectedInfo, pricing: selectedInfo.pricing ?? selectedPricing }
    : undefined;
  const hasEligibleChoices = choices.some(choice => showAll || choice.supportsImageEditing === true);
  const filteredChoices = useMemo(() => {
    return searchModelChoices(
      choices.filter((choice) => (showAll || choice.supportsImageEditing === true)
        && (!providerFilter || choice.providerId === providerFilter)),
      filter,
      (choice) => ({
        provider: getPreset(choice.preset).label,
        id: choice.id,
        name: choice.name,
      }),
    );
  }, [choices, filter, providerFilter, showAll]);
  const noneMatchesFilter = useMemo(() => {
    if (!filter.trim()) return true;
    return fuzzyFilterModels(['None turn off AI image generation'], filter).length > 0;
  }, [filter]);

  const usesResolutionShape = !!selected?.resolutions?.length || !!selected?.aspectRatios?.length;
  const selectedQuality = selected?.qualities?.includes(settings.quality)
    ? settings.quality
    : selected?.qualities?.[0];
  const selectedSize = selected?.sizes?.includes(settings.size) ? settings.size : selected?.sizes?.[0];
  const hasExactSizeOverride = usesResolutionShape && !!selected?.sizes?.some((size) => size !== 'auto');
  const exactSizeActive =
    hasExactSizeOverride && settings.useExactSize && !!selectedSize && selectedSize !== 'auto';
  const custom =
    !!selected?.supportsCustomSize && selectedSize === 'custom' && (!usesResolutionShape || exactSizeActive);
  const customValid = validCustomImageSize(settings.customWidth, settings.customHeight);
  const selectedResolution = selected?.resolutions?.includes(settings.resolution)
    ? settings.resolution
    : selected?.resolutions?.[0];
  const selectedFormat = selected?.outputFormats?.includes(settings.outputFormat)
    ? settings.outputFormat
    : selected?.outputFormats?.includes('png')
      ? 'png'
      : selected?.outputFormats?.[0];
  const visibleBackgrounds = selected?.backgrounds?.filter(
    (background) => selectedFormat !== 'jpeg' || background !== 'transparent',
  );
  const selectedBackground = visibleBackgrounds?.includes(settings.background)
    ? settings.background
    : visibleBackgrounds?.includes('auto')
      ? 'auto'
      : visibleBackgrounds?.[0];
  const lossyFormat = selectedFormat === 'jpeg' || selectedFormat === 'webp';
  const selectedCompression = selected?.outputCompressionRange
    ? Math.max(
        selected.outputCompressionRange.min,
        Math.min(selected.outputCompressionRange.max, settings.outputCompression),
      )
    : settings.outputCompression;
  const hasAdvanced =
    !!selected &&
    (custom ||
      hasExactSizeOverride ||
      !!selected.outputFormats?.length ||
      !!selected.backgrounds?.length ||
      (!!selected.outputCompressionRange && lossyFormat) ||
      !!selected.supportsSeed ||
      !!selected.moderationLevels?.length ||
      (selected.supportsImageEditing && !!selected.inputFidelities?.length));
  const selectedPrice = imagePricePresentation(selected?.pricing, {
    quality: selectedQuality,
    size: exactSizeActive || !usesResolutionShape ? selectedSize : undefined,
    resolution: exactSizeActive ? undefined : selectedResolution,
    customWidth: settings.customWidth,
    customHeight: settings.customHeight,
  });
  useEffect(() => setAdvancedOpen(false), [selected?.id, selected?.providerId]);
  const noneOption = (
    <ul className="sc-model-list sc-image-model-none">
      <li>
        <button
          type="button"
          role="option"
          aria-selected={imageModelRef == null}
          className={`sc-model-item${imageModelRef == null ? ' on' : ''}`}
          onClick={setImageModelNone}
          data-tip="Turn off AI image generation"
        >
          <span className="sc-model-check">{imageModelRef == null && <Check size={12} />}</span>
          <span className="sc-model-name">None</span>
        </button>
      </li>
    </ul>
  );
  const catalogMessage =
    imageProviders.length === 0
      ? 'Connect an image-capable provider to generate images.'
      : loading && choices.length === 0
        ? 'Loading image models…'
        : error && choices.length === 0
          ? `⚠ ${error}`
          : !hasEligibleChoices
            ? showAll ? 'No models are available from these providers.' : 'No models with confirmed image editing support are available for these providers.'
            : null;

  const picker = (
    <div className={`sc-image-model-picker${providerId ? ' sc-image-model-picker--embedded' : ''}`}>
      {!providerId && !settingsLayout && (
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Image model</div>
      )}
      {!providerId && (
        <p className="field-help" style={{ marginTop: 0, marginBottom: 8 }}>
          Choose <strong>one model with image editing support</strong> to generate images and modify whole images or selected regions.
          By default, the list only includes models with <strong>confirmed editing capabilities</strong>.
          Removing the choice <strong>turns AI image generation and modification off</strong>.
          {' '}<strong>Local image generation is not supported.</strong>
        </p>
      )}
      {imageModelRef && selectedInfo?.supportsImageEditing !== true && !loading && !error && (
        <p className={showAll ? 'field-help' : 'settings-inline-error'} role={showAll ? undefined : 'alert'}>{showAll ? 'Image generation and editing support are not confirmed for this model. Requests may fail.' : 'Your saved image model does not have confirmed editing support. Choose an editing-capable model or enable Show all models to use it at your own risk.'}</p>
      )}
      {settingsLayout && (
        <SelectedModel
          selected={imageModelRef}
          providers={providers}
          onRemove={setImageModelNone}
          role="image"
          fallback="Image generation off"
          detail={
            selected && (
              <div className="settings-selected-properties">
                <dl>
                  <div><dt>Cost:</dt><dd>{selectedPrice.label}<small>Output only; prompt and reference-image charges may be additional.</small></dd></div>
                  <div><dt>Capabilities:</dt><dd>{selected.supportsImageEditing ? 'Image generation and editing' : selected.imageCatalogEntry ? 'Image generation; editing not confirmed' : 'Image capabilities not confirmed'}</dd></div>
                  {selected.qualities?.length ? <div><dt>Quality:</dt><dd>{selectedQuality}</dd></div> : null}
                  <div><dt>Output size:</dt><dd>{exactSizeActive || !usesResolutionShape
                    ? selectedSize === 'custom' ? `${settings.customWidth} × ${settings.customHeight}`
                      : selectedSize ? imageSizeLabel(selectedSize) : 'Automatic'
                    : `${selectedResolution} · ${settings.aspectRatio}`}</dd></div>
                </dl>
              </div>
            )
          }
        />
      )}
      {catalogMessage && !selected ? (
        <>
          {loading && (
            <p className="field-help" role="status">
              Refreshing image catalog… Saved controls are ready to use.
            </p>
          )}
          {error && (
            <p className="settings-inline-error" role="alert">
              {error} Your saved selection is unchanged.
            </p>
          )}
          <div className="sc-image-model-list" role="listbox" aria-label="Image model">
            {noneOption}
          </div>
          <ModelCompatibilityOverride role="image" />
          <p className="field-help" style={error ? { color: 'var(--red)' } : undefined}>
            {catalogMessage}
          </p>
        </>
      ) : (
        <>
          <div className={settingsLayout ? 'settings-catalog-toolbar' : undefined}>
            <input
              className="input"
              type="search"
              aria-label="Filter image models"
              placeholder={providerId ? 'Filter…' : 'Filter image models…'}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {settingsLayout && (
              <ModelProviderFilter
                providers={imageProviders}
                value={providerFilter}
                onChange={setProviderFilter}
                label="Image model provider"
              />
            )}
          </div>
          <div className="sc-image-model-list" role="listbox" aria-label="Image model">
            {noneMatchesFilter && noneOption}
            {imageProviders.map((provider) => {
              const providerChoices = filteredChoices.filter((choice) => choice.providerId === provider.id);
              if (providerChoices.length === 0) return null;
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
                    {providerChoices.map((choice) => (
                      <ImageModelOption
                        key={`${choice.providerId}:${choice.id}`}
                        model={choice}
                        provider={provider}
                        allowUnverified={showAll}
                        imageCatalogEntry={choice.imageCatalogEntry}
                        selected={
                          imageModelRef?.providerId === choice.providerId && imageModelRef.model === choice.id
                        }
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
            {filteredChoices.length === 0 && !noneMatchesFilter && (
              <p className="field-help sc-image-model-empty">No {showAll ? '' : 'editing-capable image '}models match “{filter.trim()}”.</p>
            )}
            {filteredChoices.length === 0 && providerFilter && !filter.trim() && (
              <p className="field-help sc-image-model-empty">
                No {showAll ? '' : 'editing-capable image '}models are available from this provider. Choose another provider.
              </p>
            )}
          </div>

          <ModelCompatibilityOverride role="image" />
          {showAll && <p className="field-help">Lists all models from providers whose <strong>image API the app supports</strong>. This does not add image capabilities to a model.</p>}
          {selected?.qualities?.length ? (
            <div className="field-row" style={{ marginTop: 10 }}>
              <label className="field-label" htmlFor="sc-image-quality">
                Quality
              </label>
              <select
                id="sc-image-quality"
                className="input"
                value={selectedQuality}
                onChange={(event) => setSettings({ quality: event.target.value as typeof settings.quality })}
              >
                {selected.qualities.map((quality) => (
                  <option key={quality} value={quality}>
                    {titleCase(quality)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {selected?.sizes?.length && !usesResolutionShape ? (
            <div className="field-row" style={{ marginTop: 10 }}>
              <label className="field-label" htmlFor="sc-image-size">
                Size
              </label>
              <select
                id="sc-image-size"
                className="input"
                value={selectedSize}
                onChange={(event) => {
                  setSettings({ size: event.target.value, useExactSize: false });
                  if (event.target.value === 'custom') setAdvancedOpen(true);
                }}
              >
                {selected.sizes.map((size) => (
                  <option key={size} value={size}>
                    {imageSizeLabel(size)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {selected?.resolutions?.length ? (
            <div className="field-row" style={{ marginTop: 10 }}>
              <label className="field-label" htmlFor="sc-image-resolution">
                Resolution
              </label>
              <select
                id="sc-image-resolution"
                className="input"
                value={selectedResolution}
                onChange={(event) => setSettings({ resolution: event.target.value })}
              >
                {selected.resolutions.map((resolution) => (
                  <option key={resolution}>{resolution}</option>
                ))}
              </select>
            </div>
          ) : null}
          {selected?.aspectRatios?.length ? (
            <div className="field-row" style={{ marginTop: 10 }}>
              <label className="field-label" htmlFor="sc-image-ratio">
                Aspect ratio
              </label>
              <select
                id="sc-image-ratio"
                className="input"
                value={
                  selected.aspectRatios.includes(settings.aspectRatio)
                    ? settings.aspectRatio
                    : selected.aspectRatios[0]
                }
                onChange={(event) => setSettings({ aspectRatio: event.target.value })}
              >
                {selected.aspectRatios.map((ratio) => (
                  <option key={ratio}>{ratio}</option>
                ))}
              </select>
            </div>
          ) : null}
          {selected && (
            <>
              <div
                className={`sc-image-price-detail${selectedPrice.available ? '' : ' is-unavailable'}`}
                data-tip={selectedPrice.tooltip}
                aria-live="polite"
              >
                {selectedPrice.label}
              </div>
              <p className="field-help sc-image-price-note">
                <strong>MP means one million pixels</strong>. A 1,000 × 1,000 image is 1 MP.
                For prices per MP, the cost is the rate × width × height ÷ 1,000,000.{' '}
                <strong>$30/M tokens is not $30 per image</strong>: 1,000 tokens at that rate cost $0.03.
                Image token usage depends on quality and resolution.
                The <strong>per-image price</strong> is calculated when provider data allows it.
                Prompts, reference images, and provider fees may cost extra.
              </p>
            </>
          )}
          {hasAdvanced && (
            <div className="sc-image-advanced">
              <button
                type="button"
                className="sc-image-advanced-toggle"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>Advanced options</span>
              </button>
              {advancedOpen && (
                <div className="sc-image-advanced-fields">
                  {hasExactSizeOverride && selected?.sizes?.length ? (
                    <div className="field-row">
                      <label className="field-label" htmlFor="sc-image-exact-size">
                        Size
                      </label>
                      <select
                        id="sc-image-exact-size"
                        className="input"
                        value={exactSizeActive ? selectedSize : '__shape__'}
                        onChange={(event) => {
                          if (event.target.value === '__shape__') {
                            setSettings({ useExactSize: false });
                          } else {
                            setSettings({ useExactSize: true, size: event.target.value });
                          }
                        }}
                      >
                        <option value="__shape__">
                          Use{' '}
                          {selected.resolutions?.length && selected.aspectRatios?.length
                            ? 'resolution and aspect ratio'
                            : selected.resolutions?.length
                              ? 'resolution'
                              : 'aspect ratio'}
                        </option>
                        {selected.sizes
                          .filter((size) => size !== 'auto')
                          .map((size) => (
                            <option key={size} value={size}>
                              {imageSizeLabel(size)}
                            </option>
                          ))}
                      </select>
                    </div>
                  ) : null}
                  {hasExactSizeOverride && (
                    <p className="field-help">
                      <strong>Pixel dimensions</strong> override Resolution and Aspect ratio.
                      Without an override, those two settings determine the image’s <strong>size and shape</strong>.
                    </p>
                  )}
                  {custom && (
                    <div className="field-row">
                      <label className="field-label">Exact size</label>
                      <div className="sc-image-custom-size sc-image-custom-size--advanced">
                        <input
                          className="input"
                          type="number"
                          aria-label="Custom image width"
                          step={16}
                          value={settings.customWidth}
                          onChange={(event) => setSettings({ customWidth: Number(event.target.value) })}
                        />
                        <span>×</span>
                        <input
                          className="input"
                          type="number"
                          aria-label="Custom image height"
                          step={16}
                          value={settings.customHeight}
                          onChange={(event) => setSettings({ customHeight: Number(event.target.value) })}
                        />
                        {!customValid && (
                          <span className="field-help sc-image-size-error">
                            Use multiples of 16 within the supported size and shape limits.
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {selected.outputFormats?.length ? (
                    <div className="field-row">
                      <label className="field-label" htmlFor="sc-image-format">
                        Format
                      </label>
                      <select
                        id="sc-image-format"
                        className="input"
                        value={selectedFormat}
                        onChange={(event) => setSettings({ outputFormat: event.target.value })}
                      >
                        {selected.outputFormats.map((format) => (
                          <option key={format} value={format}>
                            {format.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {visibleBackgrounds?.length ? (
                    <div className="field-row">
                      <label className="field-label" htmlFor="sc-image-background">
                        Background
                      </label>
                      <select
                        id="sc-image-background"
                        className="input"
                        value={selectedBackground}
                        onChange={(event) => setSettings({ background: event.target.value })}
                      >
                        {visibleBackgrounds.map((background) => (
                          <option key={background} value={background}>
                            {titleCase(background)}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {selected.outputCompressionRange && lossyFormat ? (
                    <div className="field-row">
                      <label className="field-label" htmlFor="sc-image-compression">
                        Compression
                      </label>
                      <div className="sc-image-range">
                        <input
                          id="sc-image-compression"
                          type="range"
                          min={selected.outputCompressionRange.min}
                          max={selected.outputCompressionRange.max}
                          value={selectedCompression}
                          onChange={(event) => setSettings({ outputCompression: Number(event.target.value) })}
                        />
                        <span>{selectedCompression}%</span>
                      </div>
                    </div>
                  ) : null}
                  {selected.supportsSeed ? (
                    <div className="field-row">
                      <label className="field-label" htmlFor="sc-image-seed">
                        Seed
                      </label>
                      <input
                        id="sc-image-seed"
                        className="input"
                        type="number"
                        step={1}
                        min={selected.seedRange?.min}
                        max={selected.seedRange?.max}
                        placeholder="Random"
                        value={settings.seed ?? ''}
                        onChange={(event) => {
                          const parsed = Number(event.target.value);
                          setSettings({
                            seed:
                              event.target.value === '' || !Number.isFinite(parsed)
                                ? null
                                : Math.round(parsed),
                          });
                        }}
                      />
                    </div>
                  ) : null}
                  {selected.moderationLevels?.length ? (
                    <div className="field-row">
                      <label className="field-label" htmlFor="sc-image-moderation">
                        Moderation
                      </label>
                      <select
                        id="sc-image-moderation"
                        className="input"
                        value={
                          selected.moderationLevels.includes(settings.moderation)
                            ? settings.moderation
                            : selected.moderationLevels[0]
                        }
                        onChange={(event) => setSettings({ moderation: event.target.value })}
                      >
                        {selected.moderationLevels.map((level) => (
                          <option key={level} value={level}>
                            {titleCase(level)}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {selected.supportsImageEditing && selected.inputFidelities?.length ? (
                    <div className="field-row">
                      <label className="field-label" htmlFor="sc-image-input-fidelity">
                        Input fidelity
                      </label>
                      <select
                        id="sc-image-input-fidelity"
                        className="input"
                        value={
                          selected.inputFidelities.includes(settings.inputFidelity)
                            ? settings.inputFidelity
                            : selected.inputFidelities[0]
                        }
                        onChange={(event) => setSettings({ inputFidelity: event.target.value })}
                      >
                        {selected.inputFidelities.map((fidelity) => (
                          <option key={fidelity} value={fidelity}>
                            {titleCase(fidelity)}
                          </option>
                        ))}
                      </select>
                      <span className="field-help">Used only when modifying an existing image.</span>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
  if (!providerId) return picker;
  return (
    <div className="field-row sc-image-model-picker-row" style={{ alignItems: 'flex-start' }}>
      <label className="field-label" style={{ paddingTop: 6 }}>
        Image model
      </label>
      {picker}
    </div>
  );
}
