import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { modifyNode } from './generate';
import { getGenerationSession, resetGenerationSessionsForTests } from './generationSession';

const PLAIN = 'Old fact⟦1⟧ remains, and a new fact appears.';
const WITH_NEW_CITATION = `${PLAIN}⟦2⟧`;
const CHIPPED = 'Old [[fact]]⟦1⟧ remains, and a [[new fact]] appears.⟦2⟧';
const REVERSED_PLAIN = 'A new fact appears, while Old fact⟦1⟧ remains.';
const REVERSED_CHIPPED = 'A [[new fact]] appears⟦2⟧, while Old [[fact]]⟦1⟧ remains.';

const fake = vi.hoisted(() => ({
  calls: 0,
  sourcesAtChipStart: [] as string[],
  reverseOrder: false,
  pauseFirstPass: false,
  firstPassStarted: false,
  releaseFirstPass: null as null | (() => void),
  pauseChip: false,
  chipStarted: false,
  releaseChip: null as null | (() => void),
  emitCitation: true,
  searchUsed: true,
  searchError: undefined as string | undefined,
  reset() {
    this.calls = 0;
    this.sourcesAtChipStart = [];
    this.reverseOrder = false;
    this.pauseFirstPass = false;
    this.firstPassStarted = false;
    this.releaseFirstPass = null;
    this.pauseChip = false;
    this.chipStarted = false;
    this.releaseChip = null;
    this.emitCitation = true;
    this.searchUsed = true;
    this.searchError = undefined;
  },
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...orig,
    getAdapter: () => ({
      listModels: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamChat() {
        fake.calls++;
        if (fake.calls === 1) {
          if (fake.pauseFirstPass) {
            fake.firstPassStarted = true;
            await new Promise<void>((resolve) => { fake.releaseFirstPass = resolve; });
          }
          const body = fake.reverseOrder ? REVERSED_PLAIN : PLAIN;
          yield { delta: body, done: false };
          yield {
            delta: '', done: true,
            googleSearchSuggestions: fake.searchUsed ? ['<div>New Google attribution</div>'] : undefined,
            citations: fake.emitCitation ? [{
              url: 'https://new.example/source', title: 'New', startIndex: 0,
              endIndex: fake.reverseOrder ? 'A new fact appears'.length : PLAIN.length,
            }] : undefined,
            webSearch: {
              used: fake.searchUsed,
              requestCount: fake.searchUsed ? 1 : 0,
              error: fake.searchError,
            },
          };
          return;
        }
        const node = useGraphStore.getState().project!.nodes.n0!;
        fake.sourcesAtChipStart = (node.versions[node.currentVersionIndex]?.sources ?? []).map((s) => s.url);
        if (fake.pauseChip) {
          fake.chipStarted = true;
          await new Promise<void>((resolve) => { fake.releaseChip = resolve; });
        }
        yield { delta: '{"terms":["fact","new fact"]}', done: false };
        yield { delta: '', done: true };
      },
      capabilities: {},
    }),
  };
});

beforeEach(() => {
  fake.reset();
  resetGenerationSessionsForTests();
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'sk-test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    webSearch: true,
  });
  const node: ScatterNode = {
    id: 'n0', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    versions: [{
      header: 'Topic', body: 'Old fact⟦1⟧ remains.', createdAt: 0, generatedBy: 'term-click',
      sources: [{ n: 1, url: 'https://old.example/source', title: 'Old' }],
      googleSearchSuggestions: ['<div>Old Google attribution</div>'],
      webSearched: true, width: 540, minWidth: 430, bodyMaxHeight: 320,
      minBodyHeight: 180, maxL1Bullets: 8, contentType: 'encyclopedic',
    }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('rewrite-sources', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
  useGraphStore.getState().setActiveProjectId(project.id);
  useGraphStore.temporal.getState().clear();
});

afterEach(() => {
  resetGenerationSessionsForTests();
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('rewrite source handoff', () => {
  it('creates and selects the rewrite version before the first model text arrives', async () => {
    fake.pauseFirstPass = true;
    const rewrite = modifyNode('n0', 'add one fact');
    await vi.waitFor(() => expect(fake.firstPassStarted).toBe(true));

    const during = useGraphStore.getState().project!.nodes.n0!;
    expect(during.versions).toHaveLength(2);
    expect(during.currentVersionIndex).toBe(1);
    expect(during.versions[1]).toEqual(expect.objectContaining({
      header: 'Topic',
      body: 'Old fact⟦1⟧ remains.',
      width: 540,
      bodyMaxHeight: 320,
    }));

    fake.releaseFirstPass?.();
    await rewrite;
    expect(getGenerationSession(useGraphStore.getState().activeProjectId!, 'n0')).toBeUndefined();
  });

  it('commits surviving and new sources before chips, then preserves dimensions and final numbering', async () => {
    await modifyNode('n0', 'add one fact');
    expect(fake.sourcesAtChipStart).toEqual([
      'https://old.example/source',
      'https://new.example/source',
    ]);
    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.versions).toHaveLength(2);
    const version = node.versions[1]!;
    expect(version.body).toBe(CHIPPED);
    expect(version.googleSearchSuggestions).toEqual(['<div>Old Google attribution</div>', '<div>New Google attribution</div>']);
    expect(version.sources?.map((s) => [s.n, s.url])).toEqual([
      [1, 'https://old.example/source'],
      [2, 'https://new.example/source'],
    ]);
    expect(version).toEqual(expect.objectContaining({
      width: 540, minWidth: 430, bodyMaxHeight: 320, minBodyHeight: 180,
      maxL1Bullets: 8, contentType: 'encyclopedic',
    }));
  });

  it('finalizes citations on the committed rewrite version after the user switches versions', async () => {
    fake.reverseOrder = true;
    fake.pauseChip = true;
    const rewrite = modifyNode('n0', 'lead with the new fact');
    await vi.waitFor(() => expect(fake.chipStarted).toBe(true));

    useGraphStore.getState().updateNode('n0', { currentVersionIndex: 0 });
    fake.releaseChip?.();
    await rewrite;

    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.currentVersionIndex).toBe(0);
    expect(node.versions[0]!.body).toBe('Old fact⟦1⟧ remains.');
    expect(node.versions[1]!.body).toBe(
      'A [[new fact]] appears⟦1⟧, while Old [[fact]]⟦2⟧ remains.',
    );
    expect(node.versions[1]!.sources?.map((s) => [s.n, s.url])).toEqual([
      [1, 'https://new.example/source'],
      [2, 'https://old.example/source'],
    ]);
  });

  it('inherits metadata from the version captured at rewrite start after navigation', async () => {
    const node = useGraphStore.getState().project!.nodes.n0!;
    const source = { ...node.versions[0]!, modelUsed: 'source-model' };
    useGraphStore.getState().updateNode('n0', {
      versions: [
        {
          ...source,
          header: 'Historical', body: 'Historical body.', createdAt: -1,
          width: 410, minWidth: 390, bodyMaxHeight: 190, minBodyHeight: 120,
          modelUsed: 'historical-model',
        },
        source,
      ],
      currentVersionIndex: 1,
    });
    fake.pauseFirstPass = true;
    const rewrite = modifyNode('n0', 'add one fact');
    await vi.waitFor(() => expect(fake.firstPassStarted).toBe(true));

    useGraphStore.getState().updateNode('n0', { currentVersionIndex: 0 });
    fake.releaseFirstPass?.();
    await rewrite;

    const finished = useGraphStore.getState().project!.nodes.n0!;
    expect(finished.versions).toHaveLength(3);
    expect(finished.versions[2]).toEqual(expect.objectContaining({
      width: 540,
      minWidth: 430,
      bodyMaxHeight: 320,
      minBodyHeight: 180,
      modelUsed: source.modelUsed,
      contentType: 'encyclopedic',
    }));
  });

  it('keeps a rewritten answer and records failed search without claiming current search success', async () => {
    fake.emitCitation = false;
    fake.searchUsed = false;
    fake.searchError = 'unavailable';
    await modifyNode('n0', 'rewrite without fresh search evidence');
    const version = useGraphStore.getState().project!.nodes.n0!.versions.at(-1)!;
    expect(version.webSearched).toBeUndefined();
    expect(version.webSearchFailed).toBe(true);
    expect(version.sources?.map((s) => s.url)).toEqual(['https://old.example/source']);
    expect(version.googleSearchSuggestions).toEqual(['<div>Old Google attribution</div>']);
  });

  it('keeps the whole generation as one undoable version creation', async () => {
    await modifyNode('n0', 'add one fact');
    const temporal = useGraphStore.temporal.getState();
    expect(temporal.pastStates).toHaveLength(1);

    temporal.undo();
    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.versions).toHaveLength(1);
    expect(node.versions[0]!.body).toBe('Old fact⟦1⟧ remains.');
  });
});
