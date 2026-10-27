import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { cancelNodeGeneration, expandPart, modifyNode, retypeNodeToText } from './generate';
import { resetGenerationSessionsForTests } from './generationSession';
import { removeNodeVersion } from './nodeVersions';

const fake = vi.hoisted(() => ({
  mode: 'pause' as 'pause' | 'emit-pause' | 'partial-error' | 'finish',
  completed: false,
  release: () => {},
  started: false,
  aborted: false,
  reset() { this.mode = 'pause'; this.started = false; this.aborted = false; this.completed = false; this.release = () => {}; },
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...orig,
    getAdapter: () => ({
      listModels: async () => [],
      async *streamChat(_key: string, opts: { signal: AbortSignal }) {
        fake.started = true;
        if (fake.mode === 'finish') {
          if (fake.completed) { yield { delta: '{"terms":[]}', done: true }; return; }
          yield { delta: 'Generated replacement.', done: false };
          await new Promise<void>(resolve => { fake.release = resolve; });
          fake.completed = true;
          yield { delta: '', done: true };
          return;
        }
        if (fake.mode === 'partial-error') {
          yield { delta: 'Partially generated replacement.', done: false };
          throw new Error('provider exploded');
        }
        if (fake.mode === 'emit-pause') {
          yield { delta: 'Draft model text.', done: false };
        }
        await new Promise<void>((resolve) => {
          if (opts.signal.aborted) resolve();
          else opts.signal.addEventListener('abort', () => {
            fake.aborted = true;
            resolve();
          }, { once: true });
        });
      },
      capabilities: {},
    }),
  };
});

beforeEach(() => {
  fake.reset();
  resetGenerationSessionsForTests();
  useRewriteStore.setState({ activeByNode: {}, workingBody: {}, snapshot: {}, pendingSnapDown: {} });
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'sk-test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    webSearch: false,
  });
  const node: ScatterNode = {
    id: 'n0', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: 'Topic', body: 'Completed body.', createdAt: 0, generatedBy: 'term-click' }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('cancel-generation', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
  useGraphStore.getState().setActiveProjectId(project.id);
});

afterEach(() => {
  resetGenerationSessionsForTests();
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('cancelNodeGeneration', () => {
  it.each(['explain', 'encyclopedic', 'answer'] as const)('finishes a %s rewrite after its displayed source version is deleted', async contentType => {
    fake.mode = 'finish';
    useSettingsStore.setState({ autoTermPreviews: false, autoFreeImages: false });
    const initial = useGraphStore.getState().project!.nodes.n0!;
    useGraphStore.getState().updateNode('n0', { versions: [{ ...initial.versions[0]!, contentType }] });
    const pending = modifyNode('n0', 'rewrite it');
    await vi.waitFor(() => expect(fake.started).toBe(true));
    const current = useGraphStore.getState().project!.nodes.n0!;
    const draftCreatedAt = current.versions[1]!.createdAt;
    useGraphStore.getState().updateNode('n0', { currentVersionIndex: 0 });
    useGraphStore.getState().updateNode('n0', removeNodeVersion(current, 0)!);
    expect(useRewriteStore.getState().snapshot.n0?.draftVersionIndex).toBe(0);
    fake.release();
    await pending;
    const finished = useGraphStore.getState().project!.nodes.n0!;
    expect(finished.versions).toHaveLength(1);
    expect(finished.versions[0]).toMatchObject({ createdAt: draftCreatedAt, body: 'Generated replacement.' });
    expect(finished.generating).toBe(false);
    expect(finished.generationError).toBeUndefined();
    expect(fake.aborted).toBe(false);
  });
  it('aborts the provider and removes only the in-progress rewrite version', async () => {
    const rewrite = modifyNode('n0', 'rewrite it');
    await vi.waitFor(() => expect(fake.started).toBe(true));
    expect(useGraphStore.getState().project!.nodes.n0!.versions).toHaveLength(2);

    expect(cancelNodeGeneration('n0', { discardCurrentWork: true })).toBe('rewrite');
    await rewrite;

    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(fake.aborted).toBe(true);
    expect(node.generating).toBe(false);
    expect(node.versions).toHaveLength(1);
    expect(node.currentVersionIndex).toBe(0);
    expect(node.versions[0]!.body).toBe('Completed body.');
    expect(useRewriteStore.getState().snapshot.n0).toBeUndefined();
  });

  it('keeps model text that arrived before a rewrite failure', async () => {
    fake.mode = 'partial-error';

    await modifyNode('n0', 'rewrite it');

    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.versions).toHaveLength(2);
    expect(node.currentVersionIndex).toBe(1);
    expect(node.versions[1]!.body).toBe('Partially generated replacement.');
    expect(node.generationError).toContain('provider exploded');
  });

  it('puts the requested type and automatic header on the provisional version immediately', async () => {
    const rewrite = retypeNodeToText('n0', 'explain');
    await vi.waitFor(() => expect(fake.started).toBe(true));

    const draft = useGraphStore.getState().project!.nodes.n0!.versions[1]!;
    expect(draft.contentType).toBe('explain');
    expect(draft.header).toBe('Topic - explained');

    cancelNodeGeneration('n0', { discardCurrentWork: true });
    await rewrite;
  });

  it('identifies a partial expansion as a modify version from the click', async () => {
    const rewrite = expandPart('n0', { kind: 'freetext' });
    const draft = useGraphStore.getState().project!.nodes.n0!.versions[1]!;
    expect(draft.generatedBy).toBe('modify');

    cancelNodeGeneration('n0', { discardCurrentWork: true });
    await rewrite;
  });

  it('streams model text into the provisional version row', async () => {
    fake.mode = 'emit-pause';
    const rewrite = modifyNode('n0', 'rewrite it');
    await vi.waitFor(() => {
      expect(useGraphStore.getState().project!.nodes.n0!.versions[1]!.body)
        .toBe('Draft model text.');
    });

    cancelNodeGeneration('n0', { discardCurrentWork: true });
    await rewrite;
  });
});
