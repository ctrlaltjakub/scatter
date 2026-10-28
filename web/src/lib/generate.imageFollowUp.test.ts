import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { DEFAULT_SETTINGS, type ImageQuestionContext } from '@/store/types';
import { askImageFollowUp } from './imageFollowUp';
import { cancelNodeGeneration, generateEmptyTextNode, regenerateNode, retryGeneration } from './generate';
import { spawnEmptyTextNode } from './emptyNodes';
import { resetGenerationSessionsForTests } from './generationSession';
import { prepareImageQuestion } from './imageRegionInput';
import { collectReferencedAssetIds } from './projectBranch';
import type { StreamChatOpts } from '@/providers/types';
import { useImageSelectionStore } from '@/store/useImageSelectionStore';

const fake = vi.hoisted(() => ({ route: 'explore', calls: [] as StreamChatOpts[], fail: false, routingWait: null as Promise<void> | null,
  titleWait: null as Promise<void> | null, failTitle: false }));
const BODY = 'The **green circle** is a round shape.\n\n- Shape\n  - Edge: It curves continuously.\n  - Corners: There are none.\n- Color\n  - Fill: It is green.\n  - Background: It is pale.';
vi.mock('./termPreviews', () => ({ generateTermPreviews: vi.fn(async () => {}) }));
vi.mock('./wikimediaDiscovery', () => ({ startWikimediaDiscovery: vi.fn(async () => {}) }));
vi.mock('./imageRegionInput', () => ({ prepareImageQuestion: vi.fn(async (_projectId: string, context: ImageQuestionContext) => ({
  instructions: context.regions.length ? 'IMAGE INSTRUCTIONS: focus on selected parts' : 'IMAGE INSTRUCTIONS: whole image',
  images: [{ id: 'whole', url: 'data:image/png;base64,whole' }, ...(context.regions.length ? [{ id: 'selected', url: 'data:image/png;base64,selected' }] : [])],
})) }));
vi.mock('@/providers/registry', async (original) => ({ ...await original<typeof import('@/providers/registry')>(),
  getAdapter: () => ({ capabilities: {}, async *streamChat(_key: string, opts: StreamChatOpts) {
    fake.calls.push(opts);
    const system = opts.messages[0]?.content ?? '';
    if (system.includes("route a user's follow-up")) {
      if (fake.routingWait) await fake.routingWait;
      yield { delta: fake.route, done: true };
    } else if (system.startsWith('Write a short, informative title')) {
      if (fake.titleWait) await fake.titleWait;
      if (fake.failTitle) throw new Error('Title provider unavailable');
      yield { delta: 'Properties of the green circle', done: true };
    } else if (system.includes('REQUIRED RESPONSE FORMAT')) yield { delta: '{"terms":[]}', done: true };
    else {
      if (fake.fail) { fake.fail = false; throw new Error('test provider failure'); }
      yield { delta: fake.route === 'explain' ? 'A **circle** has a continuously curved edge.' : BODY, done: false };
      yield { delta: '', done: true };
    }
  } }),
}));
beforeEach(() => {
  fake.route = 'explore'; fake.calls = []; fake.fail = false; fake.routingWait = null;
  fake.titleWait = null; fake.failTitle = false;
  vi.mocked(prepareImageQuestion).mockClear();
  resetGenerationSessionsForTests();
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, providers: [{ id: 'p', preset: 'openrouter', apiKey: 'test', enabledModels: ['vision'] }], activeModelRef: { providerId: 'p', model: 'vision' }, webSearch: false });
  useModelCatalogStore.getState().setCatalog('p', [{ id: 'vision', caps: { vision: true, textOutput: true } }]);
  const project = createBlankProject('Image questions', 'image');
  project.selection = ['image'];
  project.nodes.image = { id: 'image', type: 'media', position: { x: 0, y: 0 }, frozen: false, groupId: 'g',
    versions: [{ header: 'Shapes', body: '', createdAt: 1, generatedBy: 'media', contentType: 'media',
      media: { kind: 'image', source: 'asset', assetId: 'original-image', mime: 'image/png' } }], currentVersionIndex: 0 };
  useGraphStore.setState({ project, activeProjectId: project.id });
  useGraphStore.temporal.getState().clear();
});
afterEach(() => { resetGenerationSessionsForTests(); useGraphStore.getState().setProject(null); });
const regions = [{ x: .5, y: 0, width: .5, height: 1 }];
describe('image follow-up generation', () => {
  it.each(['encyclopedic', 'explain'] as const)('keeps a manually added %s node’s selected image through reload, parent deletion and regeneration', async type => {
    fake.route = type === 'explain' ? 'explain' : 'explore';
    const graph = useGraphStore.getState();
    const context: ImageQuestionContext = { sourceMedia: graph.project!.nodes.image!.versions[0]!.media!, sourceVersionCreatedAt: 1,
      regions: [...regions, { x: .1, y: .2, width: .1, height: .1 }] };
    const id = spawnEmptyTextNode('image', type, context)!;
    const read = () => useGraphStore.getState().project!.nodes[id]!;
    expect(collectReferencedAssetIds([read()])).toContain('original-image');
    expect(fake.calls).toHaveLength(0);
    expect(read().versions[0]!.imageContext).toEqual(context);
    expect(read().versions[0]!.imageContext).not.toBe(context);
    expect(read().versions[0]!.imageContext!.regions).not.toBe(context.regions);
    const saved = JSON.parse(JSON.stringify(useGraphStore.getState().project!));
    delete saved.nodes.image; saved.arrows = {}; saved.rootNodeId = id;
    useGraphStore.setState({ project: saved });
    await generateEmptyTextNode(id, 'What is this shape?');
    expect(read().generationError).toBeUndefined();
    expect(read().versions[0]?.body).toContain('circle');
    expect(fake.calls.filter(call => call.imageInputs?.length)).toHaveLength(1);
    expect(fake.calls.find(call => call.imageInputs)?.imageInputs).toHaveLength(2);
    expect(vi.mocked(prepareImageQuestion).mock.lastCall?.[1]).toEqual(context);
    await regenerateNode(id);
    expect(read().generationError).toBeUndefined();
    expect(read().versions.at(-1)?.imageContext).toEqual(context);
    expect(prepareImageQuestion).toHaveBeenCalledTimes(2);
    expect(fake.calls.filter(call => call.imageInputs?.length)).toHaveLength(2);
  });
  it('recovers selected-image context from the arrow of an older blank', async () => {
    const context: ImageQuestionContext = { sourceMedia: useGraphStore.getState().project!.nodes.image!.versions[0]!.media!, regions };
    const id = spawnEmptyTextNode('image', 'explain', context)!;
    const node = useGraphStore.getState().project!.nodes[id]!;
    useGraphStore.getState().updateNode(id, { versions: [{ ...node.versions[0]!, imageContext: undefined }] });
    await generateEmptyTextNode(id, 'Explain this');
    expect(vi.mocked(prepareImageQuestion).mock.lastCall?.[1]).toEqual(context);
    expect(useGraphStore.getState().project!.nodes[id]!.versions[0]!.imageContext).toEqual(context);
  });
  it.each(['explore', 'explain'])('routes %s through the normal generation pipeline with images and one undo step', async (route) => {
    fake.route = route;
    const onSpawn = vi.fn();
    const id = await askImageFollowUp('image', 'What is this shape?', regions, onSpawn);
    const node = useGraphStore.getState().project!.nodes[id]!;
    expect(node.groupId).toBe('g');
    expect(node.versions[0]!.contentType).toBe(route === 'explore' ? 'encyclopedic' : 'explain');
    expect(node.versions[0]!.imageContext).toEqual({ sourceMedia: expect.objectContaining({ assetId: 'original-image' }), regions, sourceVersionCreatedAt: 1 });
    expect(node.versions[0]!.header).toBe('Properties of the green circle');
    expect(node.versions[0]!.imageQuestion).toBe('What is this shape?');
    expect(node.versions[0]!.imageTitleState).toBe('complete');
    const titleCall = fake.calls.find((call) => call.messages[0]?.content.startsWith('Write a short, informative title'))!;
    expect(titleCall.imageInputs).toBeUndefined();
    expect(titleCall.messages[1]?.content).toContain('What is this shape?');
    expect(titleCall.webSearch).toBe(false);
    const arrow = Object.values(useGraphStore.getState().project!.arrows).find((a) => a.toNodeId === id)!;
    expect(arrow.sourceImage).toEqual(node.versions[0]!.imageContext);
    const visual = fake.calls.filter((call) => call.imageInputs?.length);
    expect(visual).toHaveLength(1);
    expect(visual[0]!.imageInputs).toHaveLength(2);
    expect(visual[0]!.messages.at(-1)?.content).toContain('IMAGE INSTRUCTIONS: focus on selected parts');
    expect(onSpawn).toHaveBeenCalledOnce();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    expect(collectReferencedAssetIds([node])).toContain('original-image');
  });
  it('uses only the full image without a selection and retains it across regenerate', async () => {
    const id = await askImageFollowUp('image', 'Describe this', []);
    expect(Object.values(useGraphStore.getState().project!.arrows)[0]!.sourceImage).toBeUndefined();
    expect(fake.calls.find((call) => call.imageInputs)?.imageInputs).toHaveLength(1);
    expect(fake.calls.some((call) => call.messages[0]?.content.startsWith('Write a short, informative title'))).toBe(false);
    await regenerateNode(id);
    expect(prepareImageQuestion).toHaveBeenCalledTimes(2);
    expect(useGraphStore.getState().project!.nodes[id]!.versions[1]!.imageContext?.sourceMedia.assetId).toBe('original-image');
  });
  it('retries with the exact captured image even if the parent switches images', async () => {
    fake.fail = true;
    const id = await askImageFollowUp('image', 'What is here?', regions);
    expect(useGraphStore.getState().project!.nodes[id]!.generationError).toBe('test provider failure');
    const parent = useGraphStore.getState().project!.nodes.image!;
    useGraphStore.getState().updateNode('image', { versions: [{ ...parent.versions[0]!, media: { source: 'asset', kind: 'image', assetId: 'other-image' } }] });
    await retryGeneration(id);
    expect(prepareImageQuestion).toHaveBeenCalledTimes(2);
    expect(vi.mocked(prepareImageQuestion).mock.lastCall?.[1].sourceMedia.assetId).toBe('original-image');
    expect(useGraphStore.getState().project!.nodes[id]!.generationError).toBeUndefined();
  });
  it('rejects text-only models before creating a node', () => {
    useModelCatalogStore.getState().setCatalog('p', [{ id: 'vision', caps: { vision: false } }]);
    expect(() => askImageFollowUp('image', 'Describe', [])).toThrow(/supports image input/);
    expect(Object.keys(useGraphStore.getState().project!.nodes)).toEqual(['image']);
  });
  it('never spawns into a different project if the project changes during routing', async () => {
    let finish!: () => void;
    fake.routingWait = new Promise((resolve) => { finish = resolve; });
    const pending = askImageFollowUp('image', 'Describe', []);
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, id: 'different-project' });
    finish();
    await expect(pending).rejects.toThrow(/source project changed/);
    expect(Object.keys(useGraphStore.getState().project!.nodes)).toEqual(['image']);
  });
  it('clears the captured selection as soon as the question node exists', async () => {
    const project = useGraphStore.getState().project!;
    useImageSelectionStore.getState().set({ projectId: project.id, nodeId: 'image', versionCreatedAt: 1, regions });
    expect(useImageSelectionStore.getState().selection).not.toBeNull();
    const onSpawn = vi.fn(() => expect(useImageSelectionStore.getState().selection).toBeNull());
    await askImageFollowUp('image', 'What is this?', regions, onSpawn);
    expect(onSpawn).toHaveBeenCalledOnce();
  });
  it('keeps a pending placeholder until the short title completes, without creating extra undo steps', async () => {
    let finish!: () => void;
    fake.titleWait = new Promise((resolve) => { finish = resolve; });
    const pending = askImageFollowUp('image', 'Explain this', regions);
    await vi.waitFor(() => expect(fake.calls.some((call) => call.messages[0]?.content.startsWith('Write a short, informative title'))).toBe(true));
    const child = Object.values(useGraphStore.getState().project!.nodes).find((n) => n.id !== 'image')!;
    expect(child.generating).toBe(true);
    expect(child.versions[0]!.imageTitleState).toBe('pending');
    finish();
    const id = await pending;
    expect(useGraphStore.getState().project!.nodes[id]!.versions[0]!.header).toBe('Properties of the green circle');
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
  });
  it('does not overwrite a manual rename while a title request is running', async () => {
    let finish!: () => void;
    fake.titleWait = new Promise((resolve) => { finish = resolve; });
    const pending = askImageFollowUp('image', 'Explain this', regions);
    await vi.waitFor(() => expect(fake.calls.some((call) => call.messages[0]?.content.startsWith('Write a short, informative title'))).toBe(true));
    const child = Object.values(useGraphStore.getState().project!.nodes).find((n) => n.id !== 'image')!;
    useGraphStore.getState().updateNode(child.id, { versions: [{ ...child.versions[0]!, header: 'My title', headerParts: { subject: 'My title' } }] });
    finish();
    await pending;
    expect(useGraphStore.getState().project!.nodes[child.id]!.versions[0]!.header).toBe('My title');
  });
  it('falls back to the question if only the secondary title fails, keeping the answer', async () => {
    fake.failTitle = true;
    const id = await askImageFollowUp('image', 'Explain this', regions);
    const node = useGraphStore.getState().project!.nodes[id]!;
    expect(node.versions[0]!.header).toBe('Explain this');
    expect(node.versions[0]!.imageTitleState).toBe('failed');
    expect(node.versions[0]!.body).not.toBe('');
    expect(node.generationError).toBeUndefined();
    expect(node.generating).toBe(false);
  });
  it.each([false, true])('cancels the title with the answer and never recreates a deleted node (delete=%s)', async (remove) => {
    let finish!: () => void;
    fake.titleWait = new Promise((resolve) => { finish = resolve; });
    const pending = askImageFollowUp('image', 'Explain this', regions);
    await vi.waitFor(() => expect(fake.calls.some((call) => call.messages[0]?.content.startsWith('Write a short, informative title'))).toBe(true));
    const child = Object.values(useGraphStore.getState().project!.nodes).find((n) => n.id !== 'image')!;
    cancelNodeGeneration(child.id);
    if (remove) useGraphStore.getState().deleteNodeCascade(child.id);
    finish(); await pending;
    const titleCall = fake.calls.find((call) => call.messages[0]?.content.startsWith('Write a short, informative title'))!;
    expect(titleCall.signal?.aborted).toBe(true);
    const current = useGraphStore.getState().project!.nodes[child.id];
    if (remove) expect(current).toBeUndefined();
    else {
      expect(current?.versions[0]!.header).toBe('Explain this');
      expect(current?.versions[0]!.imageTitleState).toBe('failed');
      expect(current?.generating).toBe(false);
    }
  });
});
