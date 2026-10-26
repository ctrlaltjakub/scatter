import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useWikimediaTaskStore, wikimediaTaskKey } from '@/store/useWikimediaTaskStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import type { ScatterNode } from '@/store/types';
import {
  imageDiscoveryBodyFingerprint,
  startWikimediaDiscovery,
  stopWikimediaDiscovery,
} from './wikimediaDiscovery';
import { ImageCatalogError } from './imageCatalogErrors';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';

const fake = vi.hoisted(() => ({
  modelCalls: 0,
  onSearch: undefined as undefined | (() => void),
  onModel: undefined as undefined | (() => Promise<void>),
  modelOutputs: [] as string[],
  wikimediaQueries: [] as string[],
  wikipediaQueries: [] as string[],
  wikimediaResults: undefined as Array<Record<string, unknown>> | undefined,
  commonsOffsets: [] as number[],
  openversePages: [] as number[],
  nextCommons: undefined as number | undefined,
  nextOpenverse: undefined as number | undefined,
  openverseQueries: [] as string[],
  openverseOptions: [] as Array<{ fallbackQuery?: string; minimumCandidates?: number } | undefined>,
  wikimediaError: undefined as Error | undefined,
  openverseError: undefined as Error | undefined,
  openverseResults: [] as Array<Record<string, unknown>>,
  imageInputCalls: [] as Array<Array<{ id: string; url: string }>>,
  modelPrompts: [] as string[],
  modelSystemPrompts: [] as string[],
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...original,
    getAdapter: () => ({
      capabilities: {},
      listModels: async () => [],
      async *streamChat(_key: string, opts: {
        imageInputs?: Array<{ id: string; url: string }>;
        messages: Array<{ role: string; content: string }>;
      }) {
        await fake.onModel?.();
        fake.imageInputCalls.push(opts.imageInputs ?? []);
        fake.modelPrompts.push(opts.messages.at(-1)?.content ?? '');
        fake.modelSystemPrompts.push(opts.messages.find((message) => message.role === 'system')?.content ?? '');
        const call = fake.modelCalls++;
        const content = fake.modelOutputs.shift() ?? (call === 0
          ? '{"action":"search","query":"neuron diagram","language":"en"}'
          : '{"action":"finish","selections":[{"candidateId":"image-1","relevance":"The diagram shows the neuron structure discussed in this node."}]}');
        yield { delta: content, done: false };
        yield { delta: '', done: true };
      },
    }),
  };
});

vi.mock('./wikimediaApi', () => {
  const search = async (query: string) => {
    fake.wikimediaQueries.push(query);
    if (fake.wikimediaError) throw fake.wikimediaError;
    fake.onSearch?.();
    return fake.wikimediaResults ?? [{
      pageId: 7, fileTitle: 'File:Neuron.svg', thumbnailUrl: 'https://upload/thumb.png',
      originalUrl: 'https://upload/original.svg', caption: 'Neuron diagram', mime: 'image/svg+xml',
    }];
  };
  return {
  searchWikipediaLeadImages: async (query: string) => { fake.wikipediaQueries.push(query); return []; },
  searchCommonsImages: search,
  searchCommonsImagePage: async (query: string, _signal: AbortSignal, options: { offset: number }) => {
    fake.commonsOffsets.push(options.offset);
    return { results: await search(query), nextOffset: fake.nextCommons };
  },
  enrichWikimediaFiles: async (titles: readonly string[]) => titles.length === 0 ? [] : [{
    pageId: 7, fileTitle: 'File:Neuron.svg',
    filePageUrl: 'https://commons.wikimedia.org/wiki/File:Neuron.svg',
    thumbnailUrl: 'https://upload/thumb.png', originalUrl: 'https://upload/original.svg',
    caption: 'Neuron diagram', license: 'Public domain', creditLine: 'Wikimedia Commons',
  }],
}; });

vi.mock('./openverseApi', () => ({
  searchOpenverseImagePage: async (query: string, _signal: AbortSignal, options: { page: number }) => {
    fake.openverseQueries.push(query); fake.openversePages.push(options.page);
    if (fake.openverseError) throw fake.openverseError;
    return { results: fake.openverseResults, nextPage: fake.nextOpenverse };
  },
  searchOpenverseImages: async (
    query: string,
    _signal?: AbortSignal,
    options?: { fallbackQuery?: string; minimumCandidates?: number },
  ) => {
    fake.openverseQueries.push(query);
    fake.openverseOptions.push(options);
    if (fake.openverseError) throw fake.openverseError;
    return fake.openverseResults;
  },
}));

vi.mock('./visionImageInput', () => ({
  visionImageDataUrl: async (url: string) => url.includes('example.org')
    ? 'data:image/png;base64,b3BlbnZlcnNl'
    : 'data:image/png;base64,d2lraW1lZGlh',
}));

beforeEach(() => {
  fake.modelCalls = 0;
  fake.onSearch = undefined;
  fake.onModel = undefined;
  fake.modelOutputs = [];
  fake.wikimediaQueries = [];
  fake.wikipediaQueries = [];
  fake.wikimediaResults = undefined;
  fake.commonsOffsets = []; fake.openversePages = [];
  fake.nextCommons = undefined; fake.nextOpenverse = undefined;
  fake.openverseQueries = [];
  fake.openverseOptions = [];
  fake.wikimediaError = undefined;
  fake.openverseError = undefined;
  fake.openverseResults = [];
  fake.imageInputCalls = [];
  fake.modelPrompts = [];
  fake.modelSystemPrompts = [];
  useWikimediaTaskStore.setState({ tasks: {} });
  useNodeStatusStore.setState({ statuses: {}, processes: {} });
  useSettingsStore.setState({
    providers: [{
      id: 'provider', preset: 'openrouter', apiKey: 'key', enabledModels: ['model'],
    }],
    activeModelRef: { providerId: 'provider', model: 'model' },
    secondaryUseSameModel: true,
    autoFreeImages: true,
  });
  useModelCatalogStore.getState().clear();
  useModelCatalogStore.getState().setCatalog('provider', [{
    id: 'model', caps: { vision: true, textOutput: true },
  }]);
});

describe('startWikimediaDiscovery', () => {
  function readyNode() {
    const node: ScatterNode = { id: 'automatic', type: 'root', position: { x: 0, y: 0 }, frozen: false,
      versions: [{ header: 'Neurons', body: 'Signals travel through neurons.', createdAt: 23, generatedBy: 'root' }],
      currentVersionIndex: 0 };
    useGraphStore.getState().setProject({ ...createBlankProject('Images', node.id), nodes: { [node.id]: node } });
    return node;
  }

  it('lets users search directly with no AI provider and returns more than the old five-result cap', async () => {
    const node = readyNode();
    useSettingsStore.setState({ providers: [], activeModelRef: null });
    fake.wikimediaResults = Array.from({ length: 24 }, (_, i) => ({ pageId: i, fileTitle: `File:Book-${i}.jpg`,
      thumbnailUrl: `https://upload/thumb-${i}.jpg`, originalUrl: `https://upload/book-${i}.jpg`, caption: `Book ${i}` }));
    await startWikimediaDiscovery(node.id, 23, { manualQuery: '"House of Leaves"' });
    const result = useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations!;
    expect(result).toMatchObject({ mode: 'manual', manualQuery: '"House of Leaves"' });
    expect(result.model).toBeUndefined();
    expect(result.results).toHaveLength(24);
    expect(fake.modelCalls).toBe(0);
    expect(fake.imageInputCalls).toEqual([]);
    expect(fake.wikimediaQueries).toEqual(['"House of Leaves"']);
    expect(fake.openverseQueries).toEqual(['"House of Leaves"']);
    expect(fake.wikipediaQueries).toEqual([]);
  });

  it('loads subsequent catalog pages once, deduplicates results, and preserves the search text', async () => {
    const node = readyNode();
    fake.nextCommons = 24; fake.nextOpenverse = 2;
    await startWikimediaDiscovery(node.id, 23, { manualQuery: '神経細胞' });
    fake.nextCommons = undefined; fake.nextOpenverse = undefined;
    fake.openverseResults = [{ source: 'openverse', sourceId: 'new', caption: 'Neuron microscopy',
      thumbnailUrl: 'https://example.org/new.jpg', originalUrl: 'https://example.org/new.jpg', landingPageUrl: 'https://example.org/work', license: 'CC0', creditLine: 'Public domain' }];
    await startWikimediaDiscovery(node.id, 23, { manualQuery: '神経細胞', loadMore: true });
    const result = useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations!;
    expect(result.results).toHaveLength(2);
    expect(result.next).toEqual({});
    expect(fake.commonsOffsets).toEqual([0, 24]);
    expect(fake.openversePages).toEqual([1, 2]);
    expect(fake.modelCalls).toBe(0);
    await startWikimediaDiscovery(node.id, 23, { manualQuery: '神経細胞', loadMore: true });
    expect(fake.commonsOffsets).toHaveLength(2);
  });

  it('reruns AI discovery after a manual search without reusing the manual query', async () => {
    const node = readyNode();
    useSettingsStore.setState({ autoFreeImages: false });
    await startWikimediaDiscovery(node.id, 23, { manualQuery: 'My manual query' });
    expect(fake.modelCalls).toBe(0);
    await startWikimediaDiscovery(node.id, 23, { rerun: true });
    expect(fake.modelCalls).toBe(2);
    expect(fake.modelPrompts[0]).toContain('Signals travel through neurons.');
    expect(fake.modelPrompts[0]).not.toContain('My manual query');
    const result = useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations!;
    expect(result).toMatchObject({ mode: 'automatic', model: 'model' });
    expect(result.manualQuery).toBeUndefined();
    expect(fake.wikimediaQueries).toEqual(['My manual query', 'neuron diagram']);
  });

  it('reviews candidates beyond the old first-three cutoff without imposing a five-image quota', async () => {
    const node = readyNode();
    fake.wikimediaResults = Array.from({ length: 12 }, (_, i) => ({ pageId: i, fileTitle: `File:Neuron-${i}.png`,
      thumbnailUrl: `https://upload/thumb-${i}.png`, originalUrl: `https://upload/neuron-${i}.png`, caption: `Neuron ${i}` }));
    fake.modelOutputs = [JSON.stringify({ action: 'search', wikimediaQuery: 'Neuron', openverseQuery: 'Neuron' }),
      JSON.stringify({ action: 'finish', selections: Array.from({ length: 10 }, (_, i) => ({ candidateId: `image-${i + 1}`, relevance: `Neuron diagram ${i + 1}.` })) })];
    await startWikimediaDiscovery(node.id, 23);
    expect(fake.imageInputCalls[1]).toHaveLength(12);
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations!.results).toHaveLength(10);
  });

  it('can refine an empty exact-subject search without generic fallback keywords', async () => {
    const node = readyNode();
    let round = 0;
    fake.onSearch = () => { fake.wikimediaResults = ++round === 1 ? [] : undefined; };
    fake.modelOutputs = [
      JSON.stringify({ action: 'search', wikipediaQuery: 'Neuron', wikimediaQuery: 'Neuron', openverseQuery: 'Neuron' }),
      JSON.stringify({ action: 'search', selections: [], wikimediaQuery: 'Nerve cell diagram', openverseQuery: 'Nerve cell diagram' }),
      JSON.stringify({ action: 'finish', selections: [{ candidateId: 'image-1', relevance: 'A neuron diagram.' }] }),
    ];
    await startWikimediaDiscovery(node.id, 23);
    expect(fake.wikimediaQueries).toEqual(['Neuron', 'Nerve cell diagram']);
    expect(fake.modelPrompts[1]).toContain('No new images were returned');
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations!.results).toHaveLength(1);
  });

  it('keeps successful direct results and retries only the failed catalog on load more', async () => {
    const node = readyNode();
    fake.openverseError = new Error('Temporary network failure');
    await startWikimediaDiscovery(node.id, 23, { manualQuery: 'Neuron' });
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations!.next).toEqual({ openverse: 1 });
    fake.openverseError = undefined;
    fake.openverseResults = [{ source: 'openverse', sourceId: 'recovered', caption: 'Neuron microscopy',
      thumbnailUrl: 'https://example.org/recovered.jpg', originalUrl: 'https://example.org/recovered.jpg', landingPageUrl: 'https://example.org/work', license: 'CC0', creditLine: 'Public domain' }];
    await startWikimediaDiscovery(node.id, 23, { manualQuery: 'Neuron', loadMore: true });
    expect(fake.commonsOffsets).toEqual([0]);
    expect(fake.openversePages).toEqual([1, 1]);
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations!.results).toHaveLength(2);
  });

  it('does not let a stopped model request overwrite a newer direct search with its late error', async () => {
    const node = readyNode();
    let failOldRequest!: (reason: Error) => void;
    fake.onModel = () => new Promise<void>((_resolve, reject) => { failOldRequest = reject; });
    const oldSearch = startWikimediaDiscovery(node.id, 23);
    await vi.waitFor(() => expect(failOldRequest).toBeTypeOf('function'));
    stopWikimediaDiscovery(node.id, 23);
    fake.onModel = undefined;
    await startWikimediaDiscovery(node.id, 23, { manualQuery: 'New query' });
    failOldRequest(new Error('Old provider request failed while stopping'));
    await oldSearch;
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations!.manualQuery).toBe('New query');
    expect(useWikimediaTaskStore.getState().tasks[wikimediaTaskKey(node.id, 23)]).toMatchObject({ running: false, error: undefined });
  });

  it('retains accepted images across rounds and never adds generic fallback keywords', async () => {
    const node = readyNode();
    let searches = 0;
    fake.onSearch = () => {
      searches++;
      fake.wikimediaResults = [{ pageId: searches, fileTitle: `File:View-${searches}.png`,
        thumbnailUrl: `https://upload/thumb-${searches}.png`, originalUrl: `https://upload/view-${searches}.png`, caption: `View ${searches}` }];
    };
    fake.modelOutputs = [
      JSON.stringify({ action: 'search', wikimediaQuery: 'Neuron', openverseQuery: 'Neuron' }),
      JSON.stringify({ action: 'search', selections: [{ candidateId: 'image-1', relevance: 'A neuron diagram.' }], wikimediaQuery: 'Neuron microscopy', openverseQuery: 'Neuron microscopy' }),
      JSON.stringify({ action: 'finish', selections: [{ candidateId: 'image-1', relevance: 'Neurons under a microscope.' }] }),
    ];
    await startWikimediaDiscovery(node.id, 23);
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations!.results).toHaveLength(2);
    expect(fake.imageInputCalls.slice(1).map(items => items.length)).toEqual([1, 1]);
    expect(fake.wikimediaQueries).toEqual(['Neuron', 'Neuron microscopy']);
  });

  it('skips automatic requests when disabled but permits an explicit image search', async () => {
    const node = readyNode();
    useSettingsStore.setState({ autoFreeImages: false });
    await startWikimediaDiscovery(node.id, 23, { automatic: true });
    expect(fake.modelCalls).toBe(0);
    expect(useWikimediaTaskStore.getState().tasks).toEqual({});
    await startWikimediaDiscovery(node.id, 23);
    expect(fake.modelCalls).toBeGreaterThan(0);
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations?.results).toHaveLength(1);
  });

  it.each(['explain', 'interactive'] as const)('skips automatic %s searches but keeps manual searches available', async contentType => {
    const node = readyNode();
    useGraphStore.getState().updateNode(node.id, { type: contentType,
      versions: [{ ...node.versions[0]!, contentType }] });
    await startWikimediaDiscovery(node.id, 23, { automatic: true, allowDuringGeneration: true });
    expect(fake.modelCalls).toBe(0);
    expect(useWikimediaTaskStore.getState().tasks).toEqual({});
    await startWikimediaDiscovery(node.id, 23);
    expect(fake.modelCalls).toBeGreaterThan(0);
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations?.results).toHaveLength(1);
  });

  it.each(['encyclopedic', 'answer'] as const)('keeps automatic searches for %s nodes', async contentType => {
    const node = readyNode();
    useGraphStore.getState().updateNode(node.id, { versions: [{ ...node.versions[0]!, contentType }] });
    await startWikimediaDiscovery(node.id, 23, { automatic: true });
    expect(fake.modelCalls).toBeGreaterThan(0);
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations?.results).toHaveLength(1);
  });

  it('cancels an automatic search if the target version becomes an explain node', async () => {
    const node = readyNode();
    fake.onSearch = () => useGraphStore.getState().updateNode(node.id, {
      versions: [{ ...node.versions[0]!, contentType: 'explain' }],
    });
    await startWikimediaDiscovery(node.id, 23, { automatic: true });
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations).toBeUndefined();
    expect(useWikimediaTaskStore.getState().tasks[wikimediaTaskKey(node.id, 23)]?.running).not.toBe(true);
  });

  it('cancels a running automatic search when the option is switched off', async () => {
    const node = readyNode();
    fake.onSearch = () => useSettingsStore.setState({ autoFreeImages: false });
    await startWikimediaDiscovery(node.id, 23, { automatic: true });
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations).toBeUndefined();
    expect(useWikimediaTaskStore.getState().tasks[wikimediaTaskKey(node.id, 23)]?.running).not.toBe(true);
    expect(useNodeStatusStore.getState().processes[node.id]?.['wikimedia-images']?.clearedAt).toEqual(expect.any(Number));
  });
  it('does not start from an empty version before generation begins', async () => {
    const version = {
      header: 'Neurons', body: '', createdAt: 10, generatedBy: 'term-click' as const,
    };
    const node: ScatterNode = {
      id: 'n1', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0,
    };
    const project = createBlankProject('Wikimedia schedule', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    await startWikimediaDiscovery(node.id, version.createdAt);

    expect(useWikimediaTaskStore.getState().tasks).toEqual({});
  });

  it('does not start against the version that is still generating', async () => {
    const version = {
      header: 'Neurons', body: 'Partial streamed text', createdAt: 11,
      generatedBy: 'term-click' as const,
    };
    const node: ScatterNode = {
      id: 'n2', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0, generating: true,
      generatingVersionIndex: 0,
    };
    const project = createBlankProject('Wikimedia schedule', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    await startWikimediaDiscovery(node.id, version.createdAt);

    expect(useWikimediaTaskStore.getState().tasks[wikimediaTaskKey(node.id, version.createdAt)]).toBeUndefined();
  });

  it('runs beside term marking and accepts chip-only body changes', async () => {
    const version = {
      header: 'Preparing title', body: 'Signals enter through dendrites.⟦4⟧', createdAt: 111,
      generatedBy: 'term-click' as const,
    };
    const node: ScatterNode = {
      id: 'parallel', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0, generating: true,
      generatingVersionIndex: 0,
    };
    const project = createBlankProject('Parallel secondary tasks', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
    useNodeStatusStore.getState().setStatus(node.id, 'STATUS: MARKING TERMS');
    let processesOverlapped = false;
    fake.onSearch = () => {
      const status = useNodeStatusStore.getState();
      processesOverlapped = status.statuses[node.id]?.text.includes('MARKING TERMS') === true
        && status.processes[node.id]?.['wikimedia-images']?.text === 'FINDING IMAGES';
      const current = useGraphStore.getState().project!.nodes[node.id]!;
      useGraphStore.getState().updateNode(node.id, {
        versions: [{ ...current.versions[0]!, header: 'Neurons', body: 'Signals enter through [[dendrites]].⟦1⟧' }],
      });
    };

    await startWikimediaDiscovery(node.id, version.createdAt, { allowDuringGeneration: true });

    expect(processesOverlapped).toBe(true);
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations?.results)
      .toHaveLength(1);
    expect(imageDiscoveryBodyFingerprint(version)).toBe(imageDiscoveryBodyFingerprint({
      ...version,
      body: 'Signals enter through [[dendrites]].',
    }));
    expect(imageDiscoveryBodyFingerprint(version)).not.toBe(imageDiscoveryBodyFingerprint({
      ...version, body: 'Signals leave through the axon.',
    }));
    expect(imageDiscoveryBodyFingerprint({ ...version, body: '`⟦1⟧`' })).not.toBe(
      imageDiscoveryBodyFingerprint({ ...version, body: '`⟦2⟧`' }));
  });

  it('finishes discovery for a completed node restored from an older project', async () => {
    const version = {
      header: 'Neurons', body: 'A completed explanation restored from disk.', createdAt: 9,
      generatedBy: 'term-click' as const,
    };
    const node: ScatterNode = {
      id: 'old-node', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0,
    };
    const project = createBlankProject('Restored project', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    await startWikimediaDiscovery(node.id, version.createdAt);

    const task = useWikimediaTaskStore.getState().tasks[wikimediaTaskKey(node.id, version.createdAt)];
    expect(task).toMatchObject({ running: false, error: undefined });
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations?.results)
      .toHaveLength(1);
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations?.results[0]?.relevance)
      .toBe('The diagram shows the neuron structure discussed in this node.');
  });

  it('selects and describes images from their pixels and matching catalog metadata', async () => {
    fake.modelOutputs = [
      '{"action":"search","query":"neuron diagram","language":"en"}',
      '{"action":"finish","selections":[{"candidateId":"image-1","relevance":"The labeled axon and dendrites clarify how the signal path described in the node is organized."}]}',
    ];
    const version = {
      header: 'Neurons', body: 'Signals enter through dendrites and leave through the axon.',
      createdAt: 13, generatedBy: 'term-click' as const,
    };
    const node: ScatterNode = {
      id: 'descriptions', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0,
    };
    const project = createBlankProject('AI descriptions', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    await startWikimediaDiscovery(node.id, version.createdAt);

    expect(fake.modelCalls).toBe(2);
    expect(fake.imageInputCalls[0]).toEqual([]);
    expect(fake.imageInputCalls[1]).toEqual([{
      id: 'image-1', url: 'data:image/png;base64,d2lraW1lZGlh', detail: 'low',
    }]);
    expect(fake.modelPrompts[1]).toContain('"candidateId":"image-1"');
    expect(fake.modelPrompts[1]).toContain('"catalog":"Wikimedia Commons"');
    expect(fake.modelPrompts[1]).toContain('"title":"Neuron diagram"');
    expect(fake.modelSystemPrompts[1]).toContain('BOTH the actual pixels and matching metadata');
    expect(fake.modelSystemPrompts[1]).toContain('never mention the catalog, platform, filename');
    expect(fake.modelPrompts[1]).toContain('omit licensing, attribution, catalog, and technical-file information');
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations?.results[0]?.relevance)
      .toBe('The labeled axon and dendrites clarify how the signal path described in the node is organized.');
  });

  it('keeps a successful search empty when no candidate is directly relevant', async () => {
    fake.modelOutputs = [
      '{"action":"search","query":"schema therapy","language":"en"}',
      '{"action":"finish","selections":[]}',
    ];
    const version = {
      header: 'Schema therapy',
      body: 'Schema therapy is an integrative psychotherapy framework for persistent patterns.',
      createdAt: 14,
      generatedBy: 'term-click' as const,
    };
    const node: ScatterNode = {
      id: 'abstract-topic', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0,
    };
    const project = createBlankProject('No forced image', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    await startWikimediaDiscovery(node.id, version.createdAt);

    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations?.results)
      .toEqual([]);
    expect(fake.modelCalls).toBe(2);
  });

  it('gives Openverse pixels, title, description, creator, provider, and tags to the reviewer', async () => {
    fake.openverseResults = [{
      source: 'openverse', sourceId: 'ov-1',
      landingPageUrl: 'https://example.org/work/1',
      thumbnailUrl: 'https://example.org/thumb/1.jpg',
      originalUrl: 'https://example.org/original/1.jpg',
      caption: 'SECRET OPENVERSE TITLE',
      description: 'SECRET CATALOG DESCRIPTION',
      creator: 'SECRET CREATOR', provider: 'Flickr', tags: ['therapy', 'neuron'],
      mime: 'image/jpeg', width: 1200, height: 800,
      license: 'CC BY', creditLine: 'Credit',
    }];
    fake.modelOutputs = [
      '{"action":"search","wikimediaQuery":"neuron","openverseQuery":"neuron"}',
      '{"action":"finish","selections":[{"candidateId":"image-2","relevance":"The fluorescent branches visibly show the neuron’s extending processes."}]}',
    ];
    const version = {
      header: 'Neurons', body: 'Neurons extend axons and dendrites.', createdAt: 16,
      generatedBy: 'term-click' as const,
    };
    const node: ScatterNode = {
      id: 'visual-openverse', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0,
    };
    const project = createBlankProject('Visual selection', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    await startWikimediaDiscovery(node.id, version.createdAt);

    const [result] = useGraphStore.getState().project!.nodes[node.id]!
      .versions[0]!.imageRecommendations!.results;
    expect(result).toMatchObject({
      source: 'openverse', sourceId: 'ov-1',
      relevance: 'The fluorescent branches visibly show the neuron’s extending processes.',
    });
    expect(fake.modelPrompts[1]).toContain('"title":"SECRET OPENVERSE TITLE"');
    expect(fake.modelPrompts[1]).toContain('"catalogDescription":"SECRET CATALOG DESCRIPTION"');
    expect(fake.modelPrompts[1]).toContain('"creator":"SECRET CREATOR"');
    expect(fake.modelPrompts[1]).toContain('"provider":"Flickr"');
    expect(fake.modelPrompts[1]).toContain('"tags":["therapy","neuron"]');
    expect(fake.modelPrompts[1]).toContain('"format":"image/jpeg"');
    expect(fake.modelPrompts[1]).toContain('"dimensions":"1200 x 800"');
    expect(fake.modelPrompts[1]).toContain('"license":"CC BY"');
    expect(fake.imageInputCalls[1]).toEqual([
      { id: 'image-1', url: 'data:image/png;base64,d2lraW1lZGlh', detail: 'low' },
      { id: 'image-2', url: 'data:image/png;base64,b3BlbnZlcnNl', detail: 'low' },
    ]);
  });

  it('does not promote retrieval candidates when the selection response is malformed', async () => {
    fake.modelOutputs = [
      '{"action":"search","query":"schema therapy","language":"en"}',
      'not valid json',
    ];
    const version = {
      header: 'Schema therapy',
      body: 'Schema therapy is an integrative psychotherapy framework.',
      createdAt: 15,
      generatedBy: 'term-click' as const,
    };
    const node: ScatterNode = {
      id: 'malformed-selection', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0,
    };
    const project = createBlankProject('Safe malformed fallback', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    await startWikimediaDiscovery(node.id, version.createdAt);

    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations).toBeUndefined();
    expect(useWikimediaTaskStore.getState().tasks[wikimediaTaskKey(node.id, 15)]?.error).toBeTruthy();
  });

  it('finishes with a visible error instead of loading forever when the text changes mid-search', async () => {
    const version = {
      header: 'Neurons', body: 'A completed explanation of neurons.', createdAt: 12,
      generatedBy: 'term-click' as const,
    };
    const node: ScatterNode = {
      id: 'n3', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0,
    };
    const project = createBlankProject('Wikimedia schedule', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
    fake.onSearch = () => {
      const current = useGraphStore.getState().project!.nodes[node.id]!;
      useGraphStore.getState().updateNode(node.id, {
        versions: [{ ...current.versions[0]!, body: 'Text changed while discovery was active.' }],
      });
    };

    await startWikimediaDiscovery(node.id, version.createdAt);

    expect(useWikimediaTaskStore.getState().tasks[wikimediaTaskKey(node.id, version.createdAt)])
      .toMatchObject({ running: false, error: expect.stringContaining('node changed') });
  });

  it('keeps literal catalog queries and includes a Wikipedia article lookup', async () => {
    fake.modelOutputs = [
      '{"action":"search","wikimediaQuery":"neuron anatomy","openverseQuery":"neuron","wikipediaQuery":"Neuron"}',
      '{"action":"finish","selections":[]}',
    ];
    const version = { header: 'Neurons', body: 'Neurons carry signals.', createdAt: 20, generatedBy: 'term-click' as const };
    const node: ScatterNode = {
      id: 'paired', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0,
    };
    const project = createBlankProject('Paired search', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    await startWikimediaDiscovery(node.id, version.createdAt);

    expect(fake.wikimediaQueries).toEqual(['Neuron']);
    expect(fake.openverseQueries).toEqual(['Neuron']);
    expect(fake.wikipediaQueries).toEqual(['Neuron']);
    expect(fake.openverseOptions).toEqual([{ fallbackQuery: 'Neuron', minimumCandidates: 3 }]);
    expect(fake.modelSystemPrompts[0]).toContain('Do not combine unrelated visual angles');
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations?.sourceOutcomes)
      .toEqual([{ source: 'wikimedia', status: 'success' }, { source: 'openverse', status: 'success' }]);
  });

  it('commits immediate partial results when Openverse is rate-limited', async () => {
    fake.openverseError = new ImageCatalogError(
      'openverse', 'rate-limited', 'Openverse rate-limited this search.', Date.now() + 60_000,
    );
    fake.modelOutputs = [
      '{"action":"search","wikimediaQuery":"neuron diagram","openverseQuery":"neuron | axon"}',
      '{"action":"finish","selections":[{"candidateId":"image-1","relevance":"The diagram shows the neuron structure."}]}',
    ];
    const version = { header: 'Neurons', body: 'Neurons carry signals.', createdAt: 21, generatedBy: 'term-click' as const };
    const node: ScatterNode = {
      id: 'partial', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0,
    };
    const project = createBlankProject('Partial search', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    await startWikimediaDiscovery(node.id, version.createdAt);

    const result = useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations!;
    expect(result.results).toHaveLength(1);
    expect(result.sourceOutcomes).toEqual([
      { source: 'wikimedia', status: 'success' },
      expect.objectContaining({ source: 'openverse', status: 'rate-limited' }),
    ]);
  });

  it('keeps prior recommendations when neither catalog completes', async () => {
    fake.wikimediaError = new ImageCatalogError('wikimedia', 'rate-limited', 'Wikimedia rate-limited.');
    fake.openverseError = new ImageCatalogError('openverse', 'rate-limited', 'Openverse rate-limited.');
    fake.modelOutputs = [
      '{"action":"search","wikimediaQuery":"neuron","openverseQuery":"neuron"}',
    ];
    const version = {
      header: 'Neurons', body: 'Neurons carry signals.', createdAt: 22, generatedBy: 'term-click' as const,
      imageRecommendations: {
        schemaVersion: 2 as const, bodyFingerprint: 'old', providerId: 'provider', model: 'model',
        searchedAt: 1, resultLimit: 5, sourceOutcomes: [{ source: 'wikimedia' as const, status: 'success' as const }],
        results: [{ source: 'wikimedia' as const, sourceId: 'File:Old.svg', thumbnailUrl: 'old-thumb', originalUrl: 'old', caption: 'Old', license: 'PD', creditLine: 'Old' }],
      },
    };
    const node: ScatterNode = {
      id: 'both-limited', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0,
    };
    const project = createBlankProject('Both limited', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    await startWikimediaDiscovery(node.id, version.createdAt, { rerun: true });

    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]!.imageRecommendations?.results[0]?.caption)
      .toBe('Old');
    expect(useWikimediaTaskStore.getState().tasks[wikimediaTaskKey(node.id, version.createdAt)]?.sourceOutcomes)
      .toEqual([
        expect.objectContaining({ source: 'wikimedia', status: 'rate-limited' }),
        expect.objectContaining({ source: 'openverse', status: 'rate-limited' }),
      ]);
  });
});
