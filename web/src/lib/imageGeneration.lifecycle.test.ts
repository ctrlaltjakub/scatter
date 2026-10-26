import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { resetGenerationSessionsForTests } from './generationSession';
import {
  generateImageVersionFromHeader,
  generateImageInMediaNode,
  isImageGenerationErrorVersion,
  modifyImageInMediaNode,
  regenerateImageInMediaNode,
  retryImageGeneration,
  spawnImageFromSelection,
} from './imageGeneration';
import { cancelNodeGeneration } from './generate';
import { prepareSelectedImageEditReferences, selectedImageEditPrompt } from './imageRegionInput';
import { useImageSelectionStore } from '@/store/useImageSelectionStore';
import { saveAsset } from '@/opfs/assetsIO';
import { configuredPrompt } from './configuredPrompt';
import { languageInfo, type GenerationLanguage } from './languages';

const generateMock = vi.fn();
const editMock = vi.fn();
const localized = (prompt: string, language: GenerationLanguage = 'en') => prompt + '\n\n'
  + configuredPrompt('imageGenerationLanguage', { language: languageInfo(language).name });

vi.mock('@/opfs/settingsIO', async original => ({
  ...await original<typeof import('@/opfs/settingsIO')>(), saveSettings: vi.fn(async () => {}),
}));

vi.mock('@/providers/registry', () => ({
  getImageAdapter: () => ({ listModels: vi.fn(), generate: generateMock, edit: editMock }),
  resolveBaseUrl: () => 'https://images.test/v1',
}));
vi.mock('@/opfs/assetsIO', () => ({
  saveAsset: vi.fn(),
  deleteAsset: vi.fn(),
  loadAsset: vi.fn(async () => new Blob(['input'], { type: 'image/webp' })),
}));
vi.mock('./imageRegionInput', async (original) => ({
  ...await original<typeof import('./imageRegionInput')>(),
  prepareSelectedImageEditReferences: vi.fn(async () => [
    new Blob(['mask'], { type: 'image/png' }), new Blob(['close-up'], { type: 'image/png' }),
  ]),
}));

function mediaNode(): ScatterNode {
  return {
    id: 'm1', type: 'media', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: 'Media', body: 'Choose media', createdAt: 1, generatedBy: 'media', contentType: 'media', width: 400 }],
    currentVersionIndex: 0,
  };
}

beforeEach(() => {
  generateMock.mockReset();
  editMock.mockReset();
  vi.mocked(prepareSelectedImageEditReferences).mockClear();
  vi.mocked(saveAsset).mockClear();
  resetGenerationSessionsForTests();
  useImageModelCatalogStore.getState().clear();
  useSettingsStore.setState({
    ...DEFAULT_SETTINGS,
    customPrompts: undefined,
    hydrated: true,
    providers: [{ id: 'p1', preset: 'openai', apiKey: 'key', enabledModels: [] }],
    activeModelRef: null,
    imageModelRef: { providerId: 'p1', model: 'gpt-image-2' },
  });
  useImageModelCatalogStore.getState().setCatalog('p1', [{
    id: 'gpt-image-2', qualities: ['high'], sizes: ['1536x1024'], maxPromptChars: 32_000,
    supportsImageEditing: true, maxInputImages: 16,
  }]);
  const project = createBlankProject('images', 'm1');
  useGraphStore.getState().setProject({ ...project, nodes: { m1: mediaNode() } });
  useGraphStore.getState().setActiveProjectId(project.id);
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: vi.fn(async () => ({ width: 1536, height: 1024, close: vi.fn() })),
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
});

describe('media-node image generation lifecycle', () => {
  it('captures language for retries, changes it on regeneration, and preserves it on edits', async () => {
    useSettingsStore.setState({ generationLanguage: 'pl' });
    generateMock.mockRejectedValueOnce(new Error('retry me'));
    await generateImageInMediaNode('m1', 'A labelled diagram');
    useSettingsStore.setState({ generationLanguage: 'ar' });
    generateMock.mockResolvedValueOnce({ bytes: new Uint8Array([4]), mime: 'image/png' });
    await retryImageGeneration('m1');
    expect(generateMock.mock.calls[1]![1].prompt).toBe(localized('A labelled diagram', 'pl'));
    expect(useGraphStore.getState().project!.nodes.m1!.versions.at(-1)!.language).toBe('pl');
    generateMock.mockResolvedValueOnce({ bytes: new Uint8Array([4]), mime: 'image/png' });
    await regenerateImageInMediaNode('m1');
    expect(generateMock.mock.calls[2]![1].prompt).toBe(localized('A labelled diagram', 'ar'));
    useSettingsStore.setState({ generationLanguage: 'ja' });
    editMock.mockResolvedValueOnce({ bytes: new Uint8Array([4]), mime: 'image/png' });
    await modifyImageInMediaNode('m1', 'Make the background white');
    expect(editMock.mock.calls[0]![1].prompt).toBe(localized('Make the background white', 'ar'));
    expect(useGraphStore.getState().project!.nodes.m1!.versions.at(-1)!.language).toBe('ar');
  });
  it('allows an explicit unverified image model through the editing pipeline without changing metadata', async () => {
    const ref = { providerId: 'p1', model: 'unknown-image-model' };
    useSettingsStore.setState({ imageModelRef: ref });
    const source = mediaNode();
    source.versions[0]!.media = { source: 'asset', kind: 'image', assetId: 'original', mime: 'image/png', naturalWidth: 1536, naturalHeight: 1024 };
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, nodes: { m1: source } });
    useImageModelCatalogStore.getState().setCatalog('p1', [{ id: ref.model, supportsImageEditing: false }]);
    await expect(modifyImageInMediaNode('m1', 'make it blue')).rejects.toThrow('cannot edit');
    expect(editMock).not.toHaveBeenCalled();
    useSettingsStore.getState().setModelCompatibilityOverride('image', true);
    editMock.mockResolvedValueOnce({ bytes: new Uint8Array([9]), mime: 'image/png' });
    await modifyImageInMediaNode('m1', 'make it blue');
    expect(editMock).toHaveBeenCalledOnce();
    expect(useGraphStore.getState().project!.nodes.m1!.generationError).toBeUndefined();
    expect(useImageModelCatalogStore.getState().catalog.p1?.[0]?.supportsImageEditing).toBe(false);
  });
  it('blocks new generation and edits without an image model before changing the project', async () => {
    useSettingsStore.setState({ imageModelRef: null });
    const original = useGraphStore.getState().project;
    await expect(generateImageInMediaNode('m1', 'A tree')).rejects.toThrow('Choose an image model');
    await expect(generateImageVersionFromHeader('m1', { subject: 'A tree' })).rejects.toThrow('Choose an image model');
    await expect(modifyImageInMediaNode('m1', 'make it blue')).rejects.toThrow('Choose an image model');
    expect(useGraphStore.getState().project).toBe(original);
    expect(generateMock).not.toHaveBeenCalled();
    expect(editMock).not.toHaveBeenCalled();
  });

  it('does not let regeneration or retry bypass turning image generation off', async () => {
    generateMock.mockRejectedValueOnce(new Error('retry me'));
    await generateImageInMediaNode('m1', 'A tree');
    useSettingsStore.setState({ imageModelRef: null });
    const failed = useGraphStore.getState().project;
    await retryImageGeneration('m1');
    expect(useGraphStore.getState().project).toBe(failed);
    expect(generateMock).toHaveBeenCalledTimes(1);

    const node = useGraphStore.getState().project!.nodes.m1!;
    node.versions[node.currentVersionIndex]!.media = { source: 'asset', kind: 'image', assetId: 'old-image', mime: 'image/png' };
    await regenerateImageInMediaNode('m1');
    expect(useGraphStore.getState().project).toBe(failed);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a selected model removed from a loaded catalog', async () => {
    useImageModelCatalogStore.getState().setCatalog('p1', []);
    const original = useGraphStore.getState().project;
    await expect(generateImageInMediaNode('m1', 'A tree')).rejects.toThrow('Choose an available image model');
    expect(useGraphStore.getState().project).toBe(original);
    expect(generateMock).not.toHaveBeenCalled();
  });
  it.each([
    { label: 'an enlarged whole image', width: 1050, selected: false, outputWidth: 3072, outputHeight: 2048, expectedHeight: 700 },
    { label: 'an enlarged selected-area edit', width: 1050, selected: true, outputWidth: 768, outputHeight: 512, expectedHeight: 700 },
    { label: 'a smaller image', width: 350, selected: false, outputWidth: 1536, outputHeight: 1024, expectedHeight: 233 },
    { label: 'an image with changed proportions', width: 960, selected: true, outputWidth: 1024, outputHeight: 1024, expectedHeight: 960 },
  ])('preserves the node width when modifying $label', async ({ width, selected, outputWidth, outputHeight, expectedHeight }) => {
    const source = mediaNode();
    source.versions[0] = {
      ...source.versions[0]!, width, bodyMaxHeight: Math.round(width * 2 / 3),
      media: { source: 'asset', kind: 'image', assetId: 'original', mime: 'image/png', naturalWidth: 1536, naturalHeight: 1024 },
    };
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, nodes: { m1: source } });
    vi.mocked(createImageBitmap).mockResolvedValueOnce({ width: outputWidth, height: outputHeight, close: vi.fn() } as unknown as ImageBitmap);
    editMock.mockResolvedValueOnce({ bytes: new Uint8Array([9]), mime: 'image/png' });
    const history = useGraphStore.temporal.getState();
    history.clear();

    await modifyImageInMediaNode('m1', 'make it blue', selected ? [{ x: .1, y: .2, width: .3, height: .4 }] : []);

    const complete = useGraphStore.getState().project!.nodes.m1!;
    expect(complete.versions[1]).toMatchObject({
      width, bodyMaxHeight: expectedHeight,
      media: { naturalWidth: outputWidth, naturalHeight: outputHeight },
    });
    expect(complete.versions[0]).toEqual(source.versions[0]);
    // Sizing is part of the existing edit, not another undoable action.
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.nodes.m1!.versions).toEqual(source.versions);
    useGraphStore.temporal.getState().redo();
    expect(useGraphStore.getState().project!.nodes.m1!.versions[1]).toMatchObject({ width, bodyMaxHeight: expectedHeight });
  });

  it('keeps the latest draft width if resized and another version is viewed while the edit finishes', async () => {
    const source = mediaNode();
    source.versions[0] = {
      ...source.versions[0]!, width: 900, bodyMaxHeight: 600,
      media: { source: 'asset', kind: 'image', assetId: 'original', mime: 'image/png', naturalWidth: 1536, naturalHeight: 1024 },
    };
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, nodes: { m1: source } });
    let finish!: (value: { bytes: Uint8Array; mime: string }) => void;
    editMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = modifyImageInMediaNode('m1', 'make it blue');
    await vi.waitFor(() => expect(editMock).toHaveBeenCalledOnce());
    useGraphStore.getState().setVersionSize('m1', { width: 1110, bodyMaxHeight: 740 });
    useGraphStore.getState().updateNode('m1', { currentVersionIndex: 0 });
    finish({ bytes: new Uint8Array([9]), mime: 'image/png' });
    await pending;

    const complete = useGraphStore.getState().project!.nodes.m1!;
    expect(complete.currentVersionIndex).toBe(0);
    expect(complete.versions[0]).toEqual(source.versions[0]);
    expect(complete.versions[1]).toMatchObject({ width: 1110, bodyMaxHeight: 740 });
  });

  it('sends a mask and close-up, saves the complete output unchanged, and retains the source and regions for retries', async () => {
    const source = mediaNode();
    source.versions[0]!.width = 1008;
    source.versions[0]!.bodyMaxHeight = 672;
    source.versions[0]!.media = { source: 'asset', kind: 'image', assetId: 'original', mime: 'image/png', naturalWidth: 1536, naturalHeight: 1024 };
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, nodes: { m1: source } });
    const regions = [{ x: .1, y: .2, width: .3, height: .4 }, { x: .2, y: .4, width: .5, height: .1 }];
    useGraphStore.getState().setSelection(['m1']);
    useImageSelectionStore.getState().set({ projectId: useGraphStore.getState().project!.id, nodeId: 'm1', versionCreatedAt: 1, regions });
    expect(useImageSelectionStore.getState().selection).not.toBeNull();
    editMock.mockRejectedValueOnce(new Error('retry me'));
    await modifyImageInMediaNode('m1', 'make it blue', regions);
    expect(useImageSelectionStore.getState().selection).toBeNull();
    const failed = useGraphStore.getState().project!.nodes.m1!;
    expect(failed.generationError).toBe('retry me');
    expect(failed.versions[1]!.imageGeneration).toMatchObject({ sourceMedia: { assetId: 'original' }, selectedRegions: regions });
    expect(editMock.mock.calls[0]?.[1]).toMatchObject({
      referenceImages: [expect.any(Blob), expect.any(Blob)], prompt: localized(selectedImageEditPrompt('make it blue', regions)),
    });
    const generatedBytes = new Uint8Array([8, 3, 7, 12]);
    editMock.mockResolvedValueOnce({ bytes: generatedBytes, mime: 'image/webp' });
    await retryImageGeneration('m1');
    expect(prepareSelectedImageEditReferences).toHaveBeenCalledTimes(2);
    expect(prepareSelectedImageEditReferences).toHaveBeenLastCalledWith(expect.any(Blob), regions, expect.any(AbortSignal), 'mask-and-crop');
    const request = editMock.mock.calls[1]![1];
    expect(await request.image.text()).toBe('input');
    expect(await Promise.all(request.referenceImages.map((ref: Blob) => ref.text()))).toEqual(['mask', 'close-up']);
    expect(request.prompt).toBe(editMock.mock.calls[0]![1].prompt);
    const saved = vi.mocked(saveAsset).mock.calls[0]![2];
    expect(new Uint8Array(await saved.arrayBuffer())).toEqual(generatedBytes);
    const final = useGraphStore.getState().project!.nodes.m1!;
    expect(final.versions).toHaveLength(2);
    expect(final.versions[1]!.media?.mime).toBe('image/webp');
    expect(final.versions[0]!.media?.assetId).toBe('original');
    expect(final.versions[1]).toMatchObject({ width: 1008, bodyMaxHeight: 672 });
  });

  it('keeps custom selected-edit templates adaptable when a retry has a different reference-image limit', async () => {
    const source = mediaNode();
    source.versions[0]!.media = { source: 'asset', kind: 'image', assetId: 'original', mime: 'image/png' };
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, nodes: { m1: source } });
    const regions = [{ x: .1, y: .2, width: .3, height: .4 }];
    useSettingsStore.setState({ customPrompts: { imageEditSelection: 'Custom edit: {instruction}. {maskGuide}{cropGuide}Areas: {regions}', imageEditMaskGuide: 'MASK. ', imageEditCropGuide: 'CROP {cropNumber}. ' } });
    editMock.mockRejectedValueOnce(new Error('Retry'));
    await modifyImageInMediaNode('m1', 'make it blue', regions);
    expect(editMock.mock.calls[0]?.[1].prompt).toContain('MASK. CROP THIRD.');
    expect(useGraphStore.getState().project!.nodes.m1!.versions[1]?.imageGeneration?.editInstruction).toBe('make it blue');
    useImageModelCatalogStore.getState().setCatalog('p1', [{ id: 'gpt-image-2', supportsImageEditing: true, maxInputImages: 2 }]);
    vi.mocked(prepareSelectedImageEditReferences).mockResolvedValueOnce([new Blob(['close-up'])]);
    editMock.mockResolvedValueOnce({ bytes: new Uint8Array([8]), mime: 'image/png' });
    await retryImageGeneration('m1');
    expect(editMock.mock.calls[1]?.[1].prompt).toContain('Custom edit: make it blue. CROP SECOND.');
    expect(editMock.mock.calls[1]?.[1].prompt).not.toContain('MASK');
    expect(editMock.mock.calls[1]?.[1].referenceImages).toHaveLength(1);
  });

  it('upgrades older selected-edit prompts on regeneration without changing the previous version', async () => {
    const source = mediaNode();
    source.versions[0]!.width = 900;
    source.versions[0]!.bodyMaxHeight = 600;
    const media = { source: 'asset' as const, kind: 'image' as const, assetId: 'original', mime: 'image/png' };
    const regions = [{ x: .1, y: .2, width: .3, height: .4 }];
    const oldPrompt = "Edit the FIRST image according to the user's instruction below. The SECOND image is a binary selection mask at the same aspect ratio: WHITE pixels are editable, BLACK pixels must remain unchanged.\nSelected rectangles (top-left origin): 1: left 10.00%, top 20.00%, width 30.00%, height 40.00%\nUser instruction: make it blue";
    source.versions[0]!.media = { ...media, assetId: 'old-output' };
    source.versions[0]!.imageGeneration = {
      prompt: oldPrompt, promptSource: 'image-edit', providerId: 'p1', model: 'gpt-image-2',
      sourceMedia: media, selectedRegions: regions,
    };
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, nodes: { m1: source } });
    editMock.mockResolvedValueOnce({ bytes: new Uint8Array([9]), mime: 'image/png' });
    await regenerateImageInMediaNode('m1');
    expect(editMock.mock.calls[0]![1]).toMatchObject({
      prompt: localized(selectedImageEditPrompt('make it blue', regions)), referenceImages: [expect.any(Blob), expect.any(Blob)],
    });
    const versions = useGraphStore.getState().project!.nodes.m1!.versions;
    expect(versions[0]!.imageGeneration?.prompt).toBe(oldPrompt);
    expect(versions[0]!.media?.assetId).toBe('old-output');
    expect(versions[1]!.imageGeneration?.prompt).toBe(selectedImageEditPrompt('make it blue', regions));
    expect(versions[1]!.imageGeneration?.sourceMedia?.assetId).toBe('original');
    expect(versions[1]).toMatchObject({ width: 900, bodyMaxHeight: 600 });
  });

  it('does not send an edit or overwrite the original if cancelled while preparing references', async () => {
    const source = mediaNode();
    source.versions[0]!.media = { source: 'asset', kind: 'image', assetId: 'original', mime: 'image/png' };
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, nodes: { m1: source } });
    let finish!: (refs: Blob[]) => void;
    vi.mocked(prepareSelectedImageEditReferences).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = modifyImageInMediaNode('m1', 'make it blue', [{ x: .1, y: .2, width: .3, height: .4 }]);
    await vi.waitFor(() => expect(prepareSelectedImageEditReferences).toHaveBeenCalledOnce());
    expect(cancelNodeGeneration('m1', { discardCurrentWork: true })).toBe('rewrite');
    finish([new Blob(['mask']), new Blob(['crop'])]);
    await pending;
    expect(editMock).not.toHaveBeenCalled();
    expect(saveAsset).not.toHaveBeenCalled();
    const node = useGraphStore.getState().project!.nodes.m1!;
    expect(node.versions).toHaveLength(1);
    expect(node.versions[0]!.media?.assetId).toBe('original');
  });

  it.each([
    { maxInputImages: 8, mode: 'mask-and-crop' as const, refs: ['mask', 'close-up'] },
    { maxInputImages: 2, mode: 'crop' as const, refs: ['close-up'] },
    { maxInputImages: 1, mode: 'coordinates' as const, refs: [] },
    { maxInputImages: undefined, mode: 'coordinates' as const, refs: [] },
  ])('adapts selected edits to a routed model with $maxInputImages input images', async ({ maxInputImages, mode, refs }) => {
    useSettingsStore.setState({ providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'key', enabledModels: [] }],
      imageModelRef: { providerId: 'p1', model: 'vendor/edit-model' } });
    useImageModelCatalogStore.getState().setCatalog('p1', [{
      id: 'vendor/edit-model', supportsImageEditing: true, maxInputImages,
    }]);
    const source = mediaNode();
    source.versions[0]!.media = { source: 'asset', kind: 'image', assetId: 'original', mime: 'image/png' };
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, nodes: { m1: source } });
    vi.mocked(prepareSelectedImageEditReferences).mockResolvedValueOnce(refs.map((text) => new Blob([text])));
    const regions = [{ x: .1, y: .2, width: .3, height: .4 }];
    editMock.mockResolvedValueOnce({ bytes: new Uint8Array([9]), mime: 'image/png' });
    await modifyImageInMediaNode('m1', 'make it blue', regions);
    expect(prepareSelectedImageEditReferences).toHaveBeenCalledWith(expect.any(Blob), regions, expect.any(AbortSignal), mode);
    const request = editMock.mock.calls[0]![1];
    expect(request.model).toBe('vendor/edit-model');
    expect(request.referenceImages).toHaveLength(refs.length);
    expect(request.prompt).toBe(localized(selectedImageEditPrompt('make it blue', regions, mode)));
    expect(useGraphStore.getState().project!.nodes.m1!.versions[1]!.imageGeneration?.prompt).toBe(selectedImageEditPrompt('make it blue', regions, mode));
  });

  it('rejects GIF editing without creating a provisional version or calling the provider', async () => {
    const source = mediaNode();
    source.versions[0]!.media = { source: 'asset', kind: 'image', assetId: 'gif', mime: 'image/gif' };
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, nodes: { m1: source } });
    await expect(modifyImageInMediaNode('m1', 'change it')).rejects.toThrow(/GIFs/);
    expect(editMock).not.toHaveBeenCalled();
    expect(useGraphStore.getState().project!.nodes.m1!.versions).toHaveLength(1);
  });

  it('creates the provisional version immediately, then fills that same version', async () => {
    let finish!: (value: { bytes: Uint8Array; mime: string }) => void;
    generateMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = generateImageInMediaNode('m1', 'a labelled cell');
    const during = useGraphStore.getState().project!.nodes.m1!;
    expect(during.generating).toBe(true);
    expect(during.versions).toHaveLength(2);
    expect(during.currentVersionIndex).toBe(1);
    expect(during.versions[1]).toMatchObject({ width: 624, bodyMaxHeight: 416 });
    expect(during.versions[1]?.imageGeneration).toMatchObject({
      prompt: 'a labelled cell', promptSource: 'media-prompt', model: 'gpt-image-2', quality: 'high', size: '1536x1024',
    });

    finish({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    await pending;
    const complete = useGraphStore.getState().project!.nodes.m1!;
    expect(complete.generating).toBe(false);
    expect(complete.versions).toHaveLength(2);
    expect(complete.versions[1]?.media).toMatchObject({ kind: 'image', naturalWidth: 1536, naturalHeight: 1024 });
    expect(complete.versions[1]).toMatchObject({ width: 624, bodyMaxHeight: 416 });
  });

  it('retries a failed request without appending another version', async () => {
    generateMock.mockRejectedValueOnce(new Error('temporary'));
    await generateImageInMediaNode('m1', 'diagram');
    expect(useGraphStore.getState().project!.nodes.m1!.versions).toHaveLength(2);
    expect(useGraphStore.getState().project!.nodes.m1!.generationError).toBe('temporary');
    expect(isImageGenerationErrorVersion('m1', 1)).toBe(true);
    expect(isImageGenerationErrorVersion('m1', 0)).toBe(false);

    generateMock.mockResolvedValueOnce({ bytes: new Uint8Array([4]), mime: 'image/png' });
    await retryImageGeneration('m1');
    expect(generateMock.mock.calls[1]?.[1]).toMatchObject({ prompt: localized('diagram') });
    const complete = useGraphStore.getState().project!.nodes.m1!;
    expect(complete.versions).toHaveLength(2);
    expect(complete.versions[1]?.media).toBeDefined();
    expect(complete.generationError).toBeUndefined();
  });

  it('regenerates into a new version from the complete saved prompt, never the display header', async () => {
    const completePrompt = 'a precise educational diagram of a labelled cell membrane';
    generateMock.mockResolvedValueOnce({ bytes: new Uint8Array([1]), mime: 'image/png' });
    await generateImageInMediaNode('m1', completePrompt);
    const first = useGraphStore.getState().project!.nodes.m1!;
    first.versions[1] = { ...first.versions[1]!, header: 'Short display title' };
    useGraphStore.getState().updateNode('m1', { versions: [...first.versions] });

    let finish!: (value: { bytes: Uint8Array; mime: string }) => void;
    generateMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = regenerateImageInMediaNode('m1');
    const during = useGraphStore.getState().project!.nodes.m1!;
    expect(during.versions).toHaveLength(3);
    expect(during.currentVersionIndex).toBe(2);
    expect(during.versions[1]?.media).toBeDefined();
    expect(during.versions[2]?.media).toBeUndefined();
    expect(during.versions[2]?.header).toBe('Short display title');
    expect(during.versions[2]?.imageGeneration?.prompt).toBe(completePrompt);
    expect(generateMock.mock.calls[1]?.[1]).toMatchObject({ prompt: localized(completePrompt) });

    finish({ bytes: new Uint8Array([2]), mime: 'image/png' });
    await pending;
    expect(useGraphStore.getState().project!.nodes.m1!.versions[2]?.media).toBeDefined();
  });

  it('generates a new version from semantic header parts and preserves every older image', async () => {
    generateMock.mockResolvedValueOnce({ bytes: new Uint8Array([1]), mime: 'image/png' });
    await generateImageInMediaNode('m1', 'the original illustration');
    const priorMedia = useGraphStore.getState().project!.nodes.m1!.versions[1]?.media;

    let finish!: (value: { bytes: Uint8Array; mime: string }) => void;
    generateMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const parts = {
      prefix: 'Illustration',
      subject: 'A labelled mitochondrion',
      question: 'Where is ATP produced?',
      suffix: 'explained',
    };
    const pending = generateImageVersionFromHeader('m1', parts);

    const during = useGraphStore.getState().project!.nodes.m1!;
    expect(during.generating).toBe(true);
    expect(during.versions).toHaveLength(3);
    expect(during.currentVersionIndex).toBe(2);
    expect(during.versions[1]?.media).toBe(priorMedia);
    expect(during.versions[2]).toMatchObject({
      header: 'Illustration: A labelled mitochondrion: Where is ATP produced? - explained',
      headerParts: parts,
    });
    expect(during.versions[2]?.media).toBeUndefined();
    expect(generateMock.mock.calls[1]?.[1]).toMatchObject({
      prompt: localized('A labelled mitochondrion: Where is ATP produced?'),
    });

    finish({ bytes: new Uint8Array([2]), mime: 'image/png' });
    await pending;
    const complete = useGraphStore.getState().project!.nodes.m1!;
    expect(complete.versions[1]?.media).toBe(priorMedia);
    expect(complete.versions[2]?.media).toBeDefined();
  });

  it('appends an image-edit version immediately and edits the current flattened asset', async () => {
    const source = mediaNode();
    source.versions[0] = {
      ...source.versions[0]!,
      header: 'Image: Original diagram',
      media: {
        source: 'asset', kind: 'image', assetId: 'source-asset', mime: 'image/webp',
        naturalWidth: 1536, naturalHeight: 1024,
      },
    };
    useGraphStore.getState().setProject({
      ...useGraphStore.getState().project!, nodes: { m1: source },
    });
    let finish!: (value: { bytes: Uint8Array; mime: string }) => void;
    editMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    const pending = modifyImageInMediaNode('m1', 'make the mitochondrion blue');
    const during = useGraphStore.getState().project!.nodes.m1!;
    expect(during.generating).toBe(true);
    expect(during.versions).toHaveLength(2);
    expect(during.currentVersionIndex).toBe(1);
    expect(during.versions[0]?.media?.assetId).toBe('source-asset');
    expect(during.versions[1]?.media).toBeUndefined();
    expect(during.versions[1]?.imageGeneration).toMatchObject({
      prompt: 'make the mitochondrion blue',
      promptSource: 'image-edit',
      sourceMedia: { assetId: 'source-asset' },
      size: '1536x1024',
    });
    await vi.waitFor(() => {
      expect(editMock).toHaveBeenCalledWith('key', expect.objectContaining({
        prompt: localized('make the mitochondrion blue'),
        image: expect.any(Blob),
        size: '1536x1024',
      }), 'https://images.test/v1');
    });
    expect(prepareSelectedImageEditReferences).not.toHaveBeenCalled();
    expect(editMock.mock.calls[0]![1].referenceImages).toBeUndefined();

    finish({ bytes: new Uint8Array([8]), mime: 'image/png' });
    await pending;
    const complete = useGraphStore.getState().project!.nodes.m1!;
    expect(complete.generating).toBe(false);
    expect(complete.versions[0]?.media?.assetId).toBe('source-asset');
    expect(complete.versions[1]?.media).toBeDefined();
  });

  it('spawns a connected, group-inheriting media node from the exact selected passage', async () => {
    const parentBody = 'A chloroplast converts light into chemical energy.';
    const parent: ScatterNode = {
      id: 'parent', type: 'term-click', position: { x: 0, y: 0 }, frozen: false, groupId: 'g1',
      versions: [{ header: 'Photosynthesis', body: parentBody, createdAt: 8, generatedBy: 'term-click' }],
      currentVersionIndex: 0,
    };
    const project = createBlankProject('images', 'parent');
    useGraphStore.getState().setProject({ ...project, nodes: { parent }, groups: {
      g1: { id: 'g1', name: 'Biology', color: 'green', gravitate: true },
    } });
    useGraphStore.getState().setActiveProjectId(project.id);
    generateMock.mockResolvedValueOnce({ bytes: new Uint8Array([7]), mime: 'image/png' });

    const id = await spawnImageFromSelection('parent', {
      nodeId: 'parent', versionIndex: 0, sourceBody: parentBody,
      start: 2, end: 13, text: 'chloroplast',
      parts: [{ sourceField: 'ft', start: 2, end: 13, text: 'chloroplast' }],
    });
    const state = useGraphStore.getState();
    const child = state.project!.nodes[id]!;
    const incoming = Object.values(state.project!.arrows).find((arrow) => arrow.toNodeId === id)!;
    expect(child.groupId).toBe('g1');
    expect(child.versions[0]?.header).toBe('Image: chloroplast');
    expect(child.versions[0]).toMatchObject({ width: 624, bodyMaxHeight: 416 });
    expect(child.versions[0]?.imageGeneration?.prompt).toContain('Selected passage: chloroplast');
    expect(child.versions[0]?.imageGeneration?.prompt).toContain('Source node context: A chloroplast converts light into chemical energy.');
    expect(incoming.sourceSelection?.text).toBe('chloroplast');
    expect(state.panTo).toMatchObject({ kind: 'node', id, includeId: 'parent' });
  });

  it('aborts an empty-node request, removes its provisional version, and ignores the late result', async () => {
    let finish!: (value: { bytes: Uint8Array; mime: string }) => void;
    generateMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = generateImageInMediaNode('m1', 'diagram');
    expect(useGraphStore.getState().project!.nodes.m1!.versions).toHaveLength(2);
    expect(cancelNodeGeneration('m1', { discardCurrentWork: true })).toBe('rewrite');
    expect(useGraphStore.getState().project!.nodes.m1!.versions).toHaveLength(1);
    finish({ bytes: new Uint8Array([9]), mime: 'image/png' });
    await pending;
    const node = useGraphStore.getState().project!.nodes.m1!;
    expect(node.versions).toHaveLength(1);
    expect(node.versions[0]?.media).toBeUndefined();
  });
});
