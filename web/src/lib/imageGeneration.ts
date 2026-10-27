import { configuredPrompt } from '@/lib/configuredPrompt';
import { languageInfo, normalizeLanguage, versionLanguage } from './languages';
import { getImageAdapter, resolveBaseUrl } from '@/providers/registry';
import { directOpenAIImageModel } from '@/providers/images';
import { friendlyErrorMessage } from '@/providers/errors';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useGraphStore } from '@/store/useGraphStore';
import { useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { useMediaUrlStore } from '@/store/useMediaUrlStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { getGenProject, updateGenNode } from '@/store/bgGen';
import { trackGenerationVersions } from './generationVersionTracking';
import { saveAsset, deleteAsset } from '@/opfs/assetsIO';
import { createArrowSourceSelection } from './sourceSelection';
import { aspectResize, fitMediaToWidth, MEDIA_SPAWN_MAX_W, type FitResult } from './mediaSizing';
import { DEFAULT_NODE_W } from './nodeSize';
import { spawnNearParent } from './generate';
import { newId } from './ids';
import { stripChips } from './bulletParse';
import { validCustomImageSize } from './imageGenerationSettings';
import { isStillImageMedia } from './imageEditActions';
import { normalizedImageRegions } from './imageRegions';
import { prepareSelectedImageEditReferences, loadImageMediaBlob, selectedImageEditPrompt, selectedImageEditReferenceMode, upgradeSelectedImageEditPrompt } from './imageRegionInput';
import {
  flattenHeaderParts,
  imageDisplayHeader,
  imageHeaderParts,
  normalizeHeaderParts,
  semanticHeaderText,
} from './nodeHeaderText';
import {
  beginGenerationSession,
  finishGenerationSession,
  getGenerationSession,
  registerGenerationController,
} from './generationSession';
import type { NodeTextSelection } from '@/store/useNodeTextSelectionStore';
import type {
  ActiveModelRef,
  ImageGenerationProvenance,
  MediaRef,
  NodeVersion,
  ScatterNode,
  HeaderParts,
  ImageRegion,
  Settings,
} from '@/store/types';
import type { GeneratedImage, ImageModelInfo } from '@/providers/types';
import type { ProviderAccount } from '@/store/types';

interface ImageRetryArgs {
  projectId: string;
  nodeId: string;
  versionIndex: number;
  versionCreatedAt?: number;
  provenance: ImageGenerationProvenance;
}

const retryArgs = new Map<string, ImageRetryArgs>();

export function hasImageRetryArgs(nodeId: string): boolean {
  return retryArgs.has(nodeId);
}

/** Image failures belong to the provisional version that made the request,
 * not to every version of the node. The existing node-level error remains the
 * transport used by shared retry UI; this runtime association scopes where it
 * is rendered. */
export function isImageGenerationErrorVersion(nodeId: string, versionIndex: number): boolean {
  const args = retryArgs.get(nodeId);
  if (!args) return true;
  return args.versionCreatedAt == null ? args.versionIndex === versionIndex
    : getGenProject(args.projectId)?.nodes[nodeId]?.versions[versionIndex]?.createdAt === args.versionCreatedAt;
}

export function configuredImageModelAvailable(
  ref: ActiveModelRef | null | undefined,
  providers: ProviderAccount[],
  catalog: Record<string, ImageModelInfo[]>,
  allowUnverified = false,
): boolean {
  if (!ref) return false;
  const provider = providers.find((entry) => entry.id === ref.providerId);
  if (!provider?.apiKey.trim() || !getImageAdapter(provider.preset)) return false;
  const known = catalog[provider.id];
  return allowUnverified || !known || known.some((model) => model.id === ref.model);
}

export function hasConfiguredImageModel(): boolean {
  const settings = useSettingsStore.getState();
  return configuredImageModelAvailable(
    settings.imageModelRef,
    settings.providers,
    useImageModelCatalogStore.getState().catalog,
    settings.modelCompatibilityOverrides?.image === true,
  );
}

export function configuredImageEditingAvailable(
  ref: ActiveModelRef | null | undefined,
  providers: ProviderAccount[],
  catalog: Record<string, ImageModelInfo[]>,
  allowUnverified = false,
): boolean {
  if (!configuredImageModelAvailable(ref, providers, catalog, allowUnverified) || !ref) return false;
  const provider = providers.find((entry) => entry.id === ref.providerId);
  if (!provider || !getImageAdapter(provider.preset)?.edit) return false;
  if (allowUnverified) return true;
  const model = catalog[ref.providerId]?.find((entry) => entry.id === ref.model);
  if (model) return model.supportsImageEditing === true;
  return provider?.preset === 'openai'
    && directOpenAIImageModel(ref.model)?.supportsImageEditing === true;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function cleanNodeContext(value: string): string {
  return stripChips(value)
    .replace(/⟦\d+⟧/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+] |\d+[.)]\s+)/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildSelectedTextImagePrompt(input: {
  selectedText: string;
  sourceTitle: string;
  sourceBody: string;
  maxChars?: number;
}): string {
  const selectedText = normalizeText(input.selectedText);
  const title = normalizeText(input.sourceTitle);
  const context = cleanNodeContext(input.sourceBody);
  const prefix = configuredPrompt('imageFromTextPrefix');
  const suffix = configuredPrompt('imageFromTextSuffix');
  const beforeContext = `${prefix}Selected passage: ${selectedText}\nSource node title: ${title}\nSource node context: `;
  const fixed = `${beforeContext}${suffix}`;
  const maxChars = input.maxChars;
  if (maxChars != null && fixed.length > maxChars) {
    throw new Error('The selected passage is too long for this image model. Shorten the selection and try again.');
  }
  if (maxChars == null || fixed.length + context.length <= maxChars) {
    return `${beforeContext}${context}${suffix}`;
  }
  const available = Math.max(0, maxChars - fixed.length);
  const clipped = available > 1 ? `${context.slice(0, available - 1).trimEnd()}…` : '';
  return `${beforeContext}${clipped}${suffix}`;
}

async function measureImage(blob: Blob, fallbackSize?: string): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  }
  if (typeof Image !== 'undefined' && typeof URL?.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob);
    try {
      const dimensions = await new Promise<{ width: number; height: number } | null>((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve(null);
        image.src = url;
      });
      if (dimensions) return dimensions;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const match = fallbackSize?.match(/^(\d+)x(\d+)$/);
  return match
    ? { width: Number(match[1]), height: Number(match[2]) }
    : { width: 1536, height: 1024 };
}

export function resolveRequest(
  provenance: Pick<ImageGenerationProvenance, 'providerId' | 'model'>,
  settings: Pick<Settings, 'imageGenerationSettings'> = useSettingsStore.getState(),
) {
  const catalogModel = useImageModelCatalogStore.getState().catalog[provenance.providerId]
    ?.find((entry) => entry.id === provenance.model);
  const model: ImageModelInfo | undefined = catalogModel ?? (() => {
    const direct = directOpenAIImageModel(provenance.model.replace(/^openai\//i, ''));
    if (direct) return { ...direct, id: provenance.model };
    if (/google\/.*image/i.test(provenance.model)) {
      return { id: provenance.model, resolutions: ['1K', '2K', '4K'], aspectRatios: ['1:1', '3:2', '2:3'] };
    }
    return undefined;
  })();
  if (!model) return {};
  const preferred = settings.imageGenerationSettings;
  // OpenRouter treats `size` as a shorthand for resolution + aspect ratio and
  // rejects conflicting combinations. Prefer the explicit pair whenever the
  // model exposes either half; use size only for fixed-size models.
  const usesResolutionShape = !!model.resolutions?.length || !!model.aspectRatios?.length;
  const selectedSize = usesResolutionShape
    ? preferred.useExactSize && preferred.size !== 'auto' && model.sizes?.includes(preferred.size)
      ? preferred.size
      : undefined
    : model.sizes?.includes(preferred.size)
      ? preferred.size
      : model.sizes?.includes('auto') ? 'auto' : model.sizes?.[0];
  if (selectedSize === 'custom') {
    if (!model.supportsCustomSize || !validCustomImageSize(
      preferred.customWidth,
      preferred.customHeight,
    )) {
      throw new Error('The custom image size is invalid. Update it in Settings before generating.');
    }
  }
  const outputFormat = model.outputFormats?.includes(preferred.outputFormat)
    ? preferred.outputFormat
    : model.outputFormats?.includes('png') ? 'png' : model.outputFormats?.[0];
  const compatibleBackground = outputFormat === 'jpeg' && preferred.background === 'transparent'
    ? undefined
    : preferred.background;
  const background = model.backgrounds?.includes(compatibleBackground ?? '')
    ? compatibleBackground
    : model.backgrounds?.includes('auto') ? 'auto' : model.backgrounds?.[0];
  return {
    quality: model.qualities?.includes(preferred.quality)
      ? preferred.quality
      : model.qualities?.[0],
    size: selectedSize === 'custom'
      ? `${preferred.customWidth}x${preferred.customHeight}`
      : selectedSize,
    resolution: !selectedSize && model.resolutions?.includes(preferred.resolution)
      ? preferred.resolution
      : !selectedSize && model.resolutions?.includes('2K') ? '2K' : !selectedSize ? model.resolutions?.[0] : undefined,
    aspectRatio: !selectedSize && model.aspectRatios?.includes(preferred.aspectRatio)
      ? preferred.aspectRatio
      : !selectedSize && model.aspectRatios?.includes('3:2') ? '3:2' : !selectedSize ? model.aspectRatios?.[0] : undefined,
    outputFormat,
    background,
    outputCompression: model.outputCompressionRange
      && (outputFormat === 'jpeg' || outputFormat === 'webp')
      ? Math.max(model.outputCompressionRange.min, Math.min(model.outputCompressionRange.max, preferred.outputCompression))
      : undefined,
    seed: model.supportsSeed && preferred.seed != null
      ? Math.round(model.seedRange
        ? Math.max(model.seedRange.min, Math.min(model.seedRange.max, preferred.seed))
        : preferred.seed)
      : undefined,
    moderation: model.moderationLevels?.includes(preferred.moderation)
      ? preferred.moderation
      : model.moderationLevels?.includes('auto') ? 'auto' : model.moderationLevels?.[0],
    inputFidelity: model.inputFidelities?.includes(preferred.inputFidelity)
      ? preferred.inputFidelity
      : model.inputFidelities?.includes('high') ? 'high' : model.inputFidelities?.[0],
  };
}

function withResolvedOptions(provenance: ImageGenerationProvenance): ImageGenerationProvenance {
  // Explicit provenance wins so retries/regeneration keep the exact original
  // request even if the user changes global image settings meanwhile.
  return { ...resolveRequest(provenance), ...provenance };
}

function parsedSize(value: string): { width: number; height: number } | null {
  const match = value.match(/^(\d+)x(\d+)$/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function parsedRatio(value: string): number | null {
  const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

function closestByLog(values: string[], target: number, parse: (value: string) => number | null): string | undefined {
  return values.reduce<{ value?: string; score: number }>((best, value) => {
    const numeric = parse(value);
    if (numeric == null) return best;
    const score = Math.abs(Math.log(numeric / target));
    return score < best.score ? { value, score } : best;
  }, { score: Number.POSITIVE_INFINITY }).value;
}

function flexibleSizeForFrame(width: number, height: number): string | undefined {
  if (!(width > 0 && height > 0)) return undefined;
  const ratio = width / height;
  if (ratio < 1 / 3 || ratio > 3) return undefined;
  const minPixels = 655_360;
  const maxPixels = 8_294_400;
  const initialArea = width * height;
  let scale = Math.sqrt(Math.max(minPixels, Math.min(maxPixels, initialArea)) / initialArea);
  scale = Math.min(scale, 3840 / width, 3840 / height);
  for (let attempt = 0; attempt < 24; attempt++) {
    const w = Math.max(16, Math.round((width * scale) / 16) * 16);
    const h = Math.max(16, Math.round((height * scale) / 16) * 16);
    if (validCustomImageSize(w, h)) return `${w}x${h}`;
    const area = w * h;
    scale *= area < minPixels ? 1.02 : 0.98;
  }
  return undefined;
}

/** Geometry overrides for editing: retain the source frame wherever the
 * selected model can express it, otherwise choose the closest advertised
 * shape/size instead of silently applying an unrelated global shape. */
export function preservedImageEditGeometry(
  model: ImageModelInfo,
  width: number,
  height: number,
): Pick<ImageGenerationProvenance, 'size' | 'resolution' | 'aspectRatio'> {
  const ratio = width > 0 && height > 0 ? width / height : 1;
  if (model.resolutions?.length || model.aspectRatios?.length) {
    const aspectRatio = model.aspectRatios?.length
      ? closestByLog(model.aspectRatios, ratio, parsedRatio)
      : undefined;
    const longEdge = Math.max(width, height);
    const resolution = model.resolutions?.length
      ? closestByLog(model.resolutions, longEdge, (value) => {
          const match = value.match(/^(\d+(?:\.\d+)?)K$/i);
          return match ? Number(match[1]) * 1024 : /^512$/i.test(value) ? 512 : null;
        })
      : undefined;
    return { aspectRatio, resolution };
  }
  if (model.supportsCustomSize) {
    const size = flexibleSizeForFrame(width, height);
    if (size) return { size };
  }
  const concrete = (model.sizes ?? []).map((value) => ({ value, parsed: parsedSize(value) }))
    .filter((entry): entry is { value: string; parsed: { width: number; height: number } } => !!entry.parsed);
  const targetArea = Math.max(1, width * height);
  const selected = concrete.reduce<{ value?: string; score: number }>((best, entry) => {
    const entryRatio = entry.parsed.width / entry.parsed.height;
    const entryArea = entry.parsed.width * entry.parsed.height;
    const score = Math.abs(Math.log(entryRatio / ratio)) * 4 + Math.abs(Math.log(entryArea / targetArea));
    return score < best.score ? { value: entry.value, score } : best;
  }, { score: Number.POSITIVE_INFINITY }).value;
  return { size: selected ?? model.sizes?.find((value) => value === 'auto') };
}

/** Reserve the same card footprint the requested image should occupy. Explicit
 * pixel sizes mirror the eventual intrinsic-size fit; ratio-only providers use
 * Scatter's normal media spawn box. The neutral fallback matches the default
 * landscape image setting. */
export function imagePlaceholderFit(
  provenance: Pick<ImageGenerationProvenance, 'size' | 'aspectRatio'>,
): FitResult {
  const pixelSize = provenance.size?.match(/^(\d+)x(\d+)$/i);
  if (pixelSize) {
    return fitMediaToWidth(Number(pixelSize[1]), Number(pixelSize[2]));
  }
  const ratio = provenance.aspectRatio?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  const widthRatio = ratio ? Number(ratio[1]) : 3;
  const heightRatio = ratio ? Number(ratio[2]) : 2;
  const validRatio = Number.isFinite(widthRatio) && Number.isFinite(heightRatio)
    && widthRatio > 0 && heightRatio > 0;
  return fitMediaToWidth(
    validRatio ? widthRatio : 3,
    validRatio ? heightRatio : 2,
    MEDIA_SPAWN_MAX_W,
  );
}

async function runImageGeneration(args: ImageRetryArgs): Promise<void> {
  const settings = useSettingsStore.getState();
  const provider = settings.providers.find((entry) => entry.id === args.provenance.providerId);
  const adapter = provider ? getImageAdapter(provider.preset) : undefined;
  // Record ownership before any validation can fail so even configuration
  // errors stay attached to the attempted version.
  retryArgs.set(args.nodeId, args);
  if (!provider || !provider.apiKey.trim() || !adapter) {
    updateGenNode(args.projectId, args.nodeId, {
      generating: false,
      generatingVersionIndex: undefined,
      generationError: 'Connect the selected image provider again in Settings.',
    });
    return;
  }

  const session = getGenerationSession(args.projectId, args.nodeId);
  if (!session || session.draftVersionIndex !== args.versionIndex) return;
  args.versionCreatedAt ??= getGenProject(args.projectId)?.nodes[args.nodeId]?.versions[args.versionIndex]?.createdAt;
  trackGenerationVersions(session);
  const controller = new AbortController();
  const unregister = registerGenerationController(session.id, controller);
  useNodeStatusStore.getState().setProcessStatus(args.nodeId, 'image-generation', 'GENERATING IMAGE');
  try {
    const effective = withResolvedOptions(args.provenance);
    const imageModel = useImageModelCatalogStore.getState().catalog[provider.id]?.find((model) => model.id === effective.model);
    const directModel = provider.preset === 'openai' ? directOpenAIImageModel(effective.model) : undefined;
    const referenceMode = selectedImageEditReferenceMode(imageModel?.maxInputImages ?? directModel?.maxInputImages);
    if (effective.promptSource === 'image-edit' && effective.selectedRegions?.length) {
      effective.prompt = effective.editInstruction != null
        ? selectedImageEditPrompt(effective.editInstruction, effective.selectedRegions, referenceMode)
        : upgradeSelectedImageEditPrompt(effective.prompt, effective.selectedRegions, referenceMode);
    }
    const versionLanguageId = versionLanguage(getGenProject(args.projectId)?.nodes[args.nodeId]?.versions[session.draftVersionIndex]);
    const localizedPrompt = effective.prompt + '\n\n' + configuredPrompt('imageGenerationLanguage', { language: languageInfo(versionLanguageId).name });
    const maxPromptChars = imageModel?.maxPromptChars ?? directModel?.maxPromptChars;
    if (maxPromptChars && localizedPrompt.length > maxPromptChars) {
      throw new Error('The image prompt is too long for this model. Shorten the request or its template in Settings → System prompts.');
    }
    retryArgs.set(args.nodeId, { ...args, provenance: effective });
    const request = {
      model: effective.model,
      prompt: localizedPrompt,
      quality: effective.quality,
      size: effective.size,
      resolution: effective.resolution,
      aspectRatio: effective.aspectRatio,
      outputFormat: effective.outputFormat,
      background: effective.background,
      outputCompression: effective.outputCompression,
      seed: effective.seed,
      moderation: effective.moderation,
      signal: controller.signal,
    };
    let result: GeneratedImage;
    if (effective.promptSource === 'image-edit' && effective.sourceMedia) {
      if (!adapter.edit) throw new Error('The selected image provider does not support image editing.');
      const input = await loadImageMediaBlob(args.projectId, effective.sourceMedia, controller.signal);
      const referenceImages = effective.selectedRegions?.length
        ? await prepareSelectedImageEditReferences(input, effective.selectedRegions, controller.signal, referenceMode) : undefined;
      controller.signal.throwIfAborted();
      result = await adapter.edit(provider.apiKey, {
        ...request,
        image: input,
        referenceImages,
        inputFidelity: effective.inputFidelity,
      }, resolveBaseUrl(provider.preset, provider.baseUrl));
    } else {
      result = await adapter.generate(provider.apiKey, request, resolveBaseUrl(provider.preset, provider.baseUrl));
    }
    if (controller.signal.aborted || getGenerationSession(args.projectId, args.nodeId)?.id !== session.id) return;
    const currentNode = getGenProject(args.projectId)?.nodes[args.nodeId];
    const currentVersion = currentNode?.versions[session.draftVersionIndex];
    if (!currentNode || !currentVersion) return;

    const byteCopy = new Uint8Array(result.bytes.byteLength);
    byteCopy.set(result.bytes);
    // Save the model's complete, integrated edit. Cutting selected rectangles
    // back into the original here created hard seams at their boundaries.
    const blob = new Blob([byteCopy.buffer], { type: result.mime || 'image/png' });
    const dimensions = await measureImage(blob, effective.size);
    if (controller.signal.aborted || getGenerationSession(args.projectId, args.nodeId)?.id !== session.id) return;
    const assetId = newId();
    await saveAsset(args.projectId, assetId, blob);
    const stillCurrent = getGenProject(args.projectId)?.nodes[args.nodeId];
    if (!stillCurrent || controller.signal.aborted || getGenerationSession(args.projectId, args.nodeId)?.id !== session.id) {
      await deleteAsset(args.projectId, assetId);
      return;
    }
    if (useGraphStore.getState().activeProjectId === args.projectId && typeof URL?.createObjectURL === 'function') {
      useMediaUrlStore.getState().set(assetId, URL.createObjectURL(blob));
    }
    const media: MediaRef = {
      source: 'asset',
      kind: 'image',
      assetId,
      mime: blob.type,
      byteSize: blob.size,
      naturalWidth: dimensions.width,
      naturalHeight: dimensions.height,
      fileName: `scatter-generated.${blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'}`,
      wikimedia: effective.promptSource === 'image-edit' && effective.sourceMedia?.wikimedia
        ? { ...effective.sourceMedia.wikimedia, modified: true }
        : undefined,
      freeImage: effective.promptSource === 'image-edit' && effective.sourceMedia?.freeImage
        ? { ...effective.sourceMedia.freeImage, modified: true }
        : undefined,
    };
    const versions = [...stillCurrent.versions];
    const draftVersion = versions[session.draftVersionIndex]!;
    // Editing changes the image, not the user's chosen canvas size. Read the
    // latest draft (it may have been resized or no longer be the viewed version)
    // and only rederive height for the returned image's proportions.
    const displaySize = effective.promptSource === 'image-edit'
      ? aspectResize(dimensions.width, dimensions.height, draftVersion.width ?? DEFAULT_NODE_W)
      : fitMediaToWidth(dimensions.width, dimensions.height);
    versions[session.draftVersionIndex] = {
      ...draftVersion,
      body: '',
      media,
      modelUsed: effective.model,
      imageGeneration: effective,
      ...displaySize,
    };
    updateGenNode(args.projectId, args.nodeId, {
      versions,
      generating: false,
      generatingVersionIndex: undefined,
      generationError: undefined,
    });
    retryArgs.delete(args.nodeId);
  } catch (error) {
    if (!controller.signal.aborted && getGenProject(args.projectId)?.nodes[args.nodeId]) {
      updateGenNode(args.projectId, args.nodeId, {
        generating: false,
        generatingVersionIndex: undefined,
        generationError: friendlyErrorMessage(error),
      });
    }
  } finally {
    unregister();
    useNodeStatusStore.getState().clearProcessStatus(args.nodeId, 'image-generation');
    finishGenerationSession(args.projectId, args.nodeId, session.id);
  }
}

function selectedModelBase(options?: { requireEditing?: boolean }) {
  const settings = useSettingsStore.getState();
  const ref = settings.imageModelRef;
  if (!ref) throw new Error('Choose an image model in Settings first.');
  const provider = settings.providers.find((entry) => entry.id === ref.providerId);
  const adapter = provider ? getImageAdapter(provider.preset) : undefined;
  if (!provider?.apiKey.trim() || !adapter || !hasConfiguredImageModel()) {
    throw new Error('Choose an available image model in Settings first.');
  }
  const catalogInfo = useImageModelCatalogStore.getState().catalog[ref.providerId]
    ?.find((entry) => entry.id === ref.model);
  const directInfo = provider.preset === 'openai' ? directOpenAIImageModel(ref.model) ?? undefined : undefined;
  const info = catalogInfo && directInfo
    ? { ...catalogInfo, maxInputImages: catalogInfo.maxInputImages ?? directInfo.maxInputImages }
    : catalogInfo ?? directInfo;
  if (options?.requireEditing && (!adapter.edit || (!settings.modelCompatibilityOverrides?.image && info?.supportsImageEditing !== true))) {
    throw new Error('The selected image model can generate images but cannot edit an existing image.');
  }
  return { ref, info };
}

export async function generateImageInMediaNode(nodeId: string, rawPrompt: string): Promise<void> {
  const prompt = rawPrompt.trim();
  if (!prompt) return;
  const { ref, info } = selectedModelBase();
  if (info?.maxPromptChars && prompt.length > info.maxPromptChars) {
    throw new Error(`This prompt is too long for ${info.name ?? info.id}.`);
  }
  const graph = useGraphStore.getState();
  const project = graph.project;
  const node = project?.nodes[nodeId];
  const source = node?.versions[node.currentVersionIndex];
  if (!project || !node || !source || node.generating || source.media) return;
  const provenance = withResolvedOptions({
    prompt,
    promptSource: 'media-prompt',
    providerId: ref.providerId,
    model: ref.model,
  });
  const placeholderFit = imagePlaceholderFit(provenance);
  const draft: NodeVersion = {
    header: source.header === 'Media' ? imageDisplayHeader(prompt) : source.header,
    language: normalizeLanguage(useSettingsStore.getState().generationLanguage),
    headerParts: source.header === 'Media'
      ? imageHeaderParts(prompt)
      : source.headerParts ?? imageHeaderParts(prompt),
    body: '',
    createdAt: Date.now(),
    generatedBy: 'media',
    contentType: 'media',
    ...placeholderFit,
    imageGeneration: provenance,
  };
  const versions = [...node.versions, draft];
  const versionIndex = versions.length - 1;
  const session = beginGenerationSession({
    projectId: project.id,
    nodeId,
    kind: 'rewrite',
    sourceVersionIndex: node.currentVersionIndex,
    draftVersionIndex: versionIndex,
  });
  graph.updateNode(nodeId, {
    versions,
    currentVersionIndex: versionIndex,
    generating: true,
    generatingVersionIndex: versionIndex,
    generationError: undefined,
  });
  await runImageGeneration({ projectId: project.id, nodeId, versionIndex, provenance });
  if (getGenerationSession(project.id, nodeId)?.id === session.id) {
    finishGenerationSession(project.id, nodeId, session.id);
  }
}

/** Generate another variation of an existing AI image as a new version.
 * The saved provenance is the source of truth: compact or manually edited
 * display headers are never sent to the image provider. */
export async function regenerateImageInMediaNode(nodeId: string): Promise<void> {
  // The saved provenance preserves the original prompt/model, but must not
  // bypass the user's current choice to turn image generation off.
  if (!hasConfiguredImageModel()) return;
  const graph = useGraphStore.getState();
  const project = graph.project;
  const node = project?.nodes[nodeId];
  const source = node?.versions[node.currentVersionIndex];
  if (!project || !node || !source?.media || !source.imageGeneration || node.generating) return;

  const provenance = { ...source.imageGeneration };
  const draft: NodeVersion = provenance.promptSource === 'image-edit'
    ? {
        ...source,
        body: '',
        media: undefined,
        createdAt: Date.now(),
        generatedBy: 'media',
        contentType: 'media',
        imageGeneration: provenance,
      }
    : {
        header: source.header,
        headerParts: source.headerParts,
        body: '',
        createdAt: Date.now(),
        generatedBy: 'media',
        contentType: 'media',
        ...imagePlaceholderFit(provenance),
        imageGeneration: provenance,
      };
  draft.language = normalizeLanguage(useSettingsStore.getState().generationLanguage);
  const versions = [...node.versions, draft];
  const versionIndex = versions.length - 1;
  const session = beginGenerationSession({
    projectId: project.id,
    nodeId,
    kind: 'rewrite',
    sourceVersionIndex: node.currentVersionIndex,
    draftVersionIndex: versionIndex,
  });
  graph.updateNode(nodeId, {
    versions,
    currentVersionIndex: versionIndex,
    generating: true,
    generatingVersionIndex: versionIndex,
    generationError: undefined,
  });
  await runImageGeneration({ projectId: project.id, nodeId, versionIndex, provenance });
  if (getGenerationSession(project.id, nodeId)?.id === session.id) {
    finishGenerationSession(project.id, nodeId, session.id);
  }
}

/** Generate a new image from the complete semantic header currently shown in
 * the image editor. Unlike Regenerate, this intentionally replaces the saved
 * provider prompt with the edited subject/question. */
export async function generateImageVersionFromHeader(
  nodeId: string,
  rawParts: HeaderParts,
): Promise<void> {
  const parts = normalizeHeaderParts(rawParts);
  const prompt = semanticHeaderText(parts);
  if (!prompt) return;
  const { ref, info } = selectedModelBase();
  if (info?.maxPromptChars && prompt.length > info.maxPromptChars) {
    throw new Error(`This prompt is too long for ${info.name ?? info.id}.`);
  }
  const graph = useGraphStore.getState();
  const project = graph.project;
  const node = project?.nodes[nodeId];
  if (!project || !node || node.generating) return;
  const provenance = withResolvedOptions({
    prompt,
    promptSource: 'media-prompt',
    providerId: ref.providerId,
    model: ref.model,
  });
  const draft: NodeVersion = {
    header: flattenHeaderParts(parts),
    language: normalizeLanguage(useSettingsStore.getState().generationLanguage),
    headerParts: parts,
    body: '',
    createdAt: Date.now(),
    generatedBy: 'media',
    contentType: 'media',
    ...imagePlaceholderFit(provenance),
    imageGeneration: provenance,
  };
  const versions = [...node.versions, draft];
  const versionIndex = versions.length - 1;
  const session = beginGenerationSession({
    projectId: project.id,
    nodeId,
    kind: 'rewrite',
    sourceVersionIndex: node.currentVersionIndex,
    draftVersionIndex: versionIndex,
  });
  graph.updateNode(nodeId, {
    versions,
    currentVersionIndex: versionIndex,
    generating: true,
    generatingVersionIndex: versionIndex,
    generationError: undefined,
  });
  await runImageGeneration({ projectId: project.id, nodeId, versionIndex, provenance });
  if (getGenerationSession(project.id, nodeId)?.id === session.id) {
    finishGenerationSession(project.id, nodeId, session.id);
  }
}

/** Apply a text instruction to the current flattened image. The source image
 * is retained in provenance so Regenerate produces another variation from the
 * same input rather than repeatedly editing the already-edited output. */
export async function modifyImageInMediaNode(nodeId: string, rawInstruction: string, selectedRegions: readonly ImageRegion[] = []): Promise<void> {
  const instruction = rawInstruction.replace(/\s+/g, ' ').trim();
  if (!instruction) return;
  const { ref, info } = selectedModelBase({ requireEditing: true });
  if (!info) throw new Error('Scatter is still checking whether this image model supports editing.');
  const regions = normalizedImageRegions(selectedRegions);
  const prompt = selectedImageEditPrompt(instruction, regions, selectedImageEditReferenceMode(info.maxInputImages));
  if (info.maxPromptChars && prompt.length > info.maxPromptChars) {
    throw new Error(`This instruction is too long for ${info.name ?? info.id}.`);
  }
  const graph = useGraphStore.getState();
  const project = graph.project;
  const node = project?.nodes[nodeId];
  const source = node?.versions[node.currentVersionIndex];
  const sourceMedia = source?.media;
  if (!project || !node || !source || !sourceMedia || node.generating) return;
  if (!isStillImageMedia(sourceMedia)) {
    throw new Error('This action is available only for still images, not GIFs or videos.');
  }
  const base = withResolvedOptions({
    prompt,
    promptSource: 'image-edit',
    editInstruction: instruction,
    providerId: ref.providerId,
    model: ref.model,
    sourceMedia: { ...sourceMedia },
    ...(regions.length ? { selectedRegions: regions } : {}),
  });
  const geometry = preservedImageEditGeometry(
    info,
    sourceMedia.naturalWidth ?? 1024,
    sourceMedia.naturalHeight ?? 1024,
  );
  const provenance: ImageGenerationProvenance = {
    ...base,
    ...(geometry.size ? { size: geometry.size } : {}),
    ...(geometry.resolution ? { resolution: geometry.resolution } : {}),
    ...(geometry.aspectRatio ? { aspectRatio: geometry.aspectRatio } : {}),
  };
  const draft: NodeVersion = {
    ...source,
    body: '',
    media: undefined,
    createdAt: Date.now(),
    generatedBy: 'media',
    contentType: 'media',
    modelUsed: ref.model,
    imageGeneration: provenance,
  };
  const versions = [...node.versions, draft];
  const versionIndex = versions.length - 1;
  beginGenerationSession({
    projectId: project.id,
    nodeId,
    kind: 'rewrite',
    sourceVersionIndex: node.currentVersionIndex,
    draftVersionIndex: versionIndex,
  });
  graph.updateNode(nodeId, {
    versions,
    currentVersionIndex: versionIndex,
    generating: true,
    generatingVersionIndex: versionIndex,
    generationError: undefined,
  });
  await runImageGeneration({ projectId: project.id, nodeId, versionIndex, provenance });
}

export async function spawnImageFromSelection(
  parentId: string,
  selection: NodeTextSelection,
): Promise<string> {
  const { ref, info } = selectedModelBase();
  const graph = useGraphStore.getState();
  const project = graph.project;
  const parent = project?.nodes[parentId];
  const parentVersion = parent?.versions[selection.versionIndex];
  if (!project || !parent || !parentVersion) return '';
  if (selection.nodeId !== parentId || selection.sourceBody !== parentVersion.body) return '';
  const prompt = buildSelectedTextImagePrompt({
    selectedText: selection.text,
    sourceTitle: parentVersion.header,
    sourceBody: parentVersion.body,
    maxChars: info?.maxPromptChars,
  });
  const provenance = withResolvedOptions({
    prompt,
    promptSource: 'selected-text',
    providerId: ref.providerId,
    model: ref.model,
  });
  const placeholderFit = imagePlaceholderFit(provenance);
  const id = newId();
  const version: NodeVersion = {
    header: imageDisplayHeader(selection.text),
    language: normalizeLanguage(useSettingsStore.getState().generationLanguage),
    headerParts: imageHeaderParts(selection.text),
    body: '',
    createdAt: Date.now(),
    generatedBy: 'media',
    contentType: 'media',
    ...placeholderFit,
    imageGeneration: provenance,
  };
  const node: ScatterNode = {
    id,
    type: 'media',
    position: spawnNearParent(parent, Object.values(project.nodes)),
    frozen: false,
    groupId: parent.groupId,
    versions: [version],
    currentVersionIndex: 0,
    generating: true,
    generatingVersionIndex: 0,
  };
  const sourceSelection = createArrowSourceSelection(selection, parentVersion.createdAt);
  graph.addNodeWithArrow(node, {
    id: newId(),
    fromNodeId: parentId,
    toNodeId: id,
    kind: 'auto',
    sourceAnswer: parentVersion.chat ? { turnId: parentVersion.chat.turnId, versionCreatedAt: parentVersion.createdAt } : undefined,
    ...(sourceSelection ? { sourceSelection } : {}),
  });
  graph.requestPanTo(id, parentId, 'newNodes');
  beginGenerationSession({
    projectId: project.id,
    nodeId: id,
    kind: 'spawn',
    sourceVersionIndex: null,
    draftVersionIndex: 0,
  });
  await runImageGeneration({ projectId: project.id, nodeId: id, versionIndex: 0, provenance });
  return id;
}

export async function retryImageGeneration(nodeId: string): Promise<void> {
  if (!hasConfiguredImageModel()) return;
  const args = retryArgs.get(nodeId);
  const node = args ? getGenProject(args.projectId)?.nodes[nodeId] : undefined;
  if (args?.versionCreatedAt != null && node) args.versionIndex = node.versions.findIndex(version => version.createdAt === args.versionCreatedAt);
  if (!args || !node || !node.versions[args.versionIndex] || node.generating) return;
  const kind = node.versions.length === 1 ? 'spawn' : 'rewrite';
  beginGenerationSession({
    projectId: args.projectId,
    nodeId,
    kind,
    sourceVersionIndex: kind === 'rewrite' ? Math.max(0, args.versionIndex - 1) : null,
    draftVersionIndex: args.versionIndex,
  });
  updateGenNode(args.projectId, nodeId, {
    generating: true,
    generatingVersionIndex: args.versionIndex,
    generationError: undefined,
  });
  await runImageGeneration(args);
}
