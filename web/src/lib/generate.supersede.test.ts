import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { elaborateNode, expandPart } from './generate';
import { resetGenerationSessionsForTests } from './generationSession';

const ORIGINAL = `Original opening.

- First area
  - Original first detail.
- Second area
  - Original second detail.`;
const WHOLE = `Expanded opening.

- First area
  - Expanded first detail.
- Second area
  - Expanded second detail.`;

const fake = vi.hoisted(() => ({
  calls: 0,
  partialStarted: false,
  partialAborted: false,
  wholePrompt: '',
  reset() {
    this.calls = 0;
    this.partialStarted = false;
    this.partialAborted = false;
    this.wholePrompt = '';
  },
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...orig,
    getAdapter: () => ({
      listModels: async () => [],
      async *streamChat(_key: string, opts: {
        signal: AbortSignal;
        messages: { content: string }[];
      }) {
        fake.calls++;
        if (fake.calls === 1) {
          fake.partialStarted = true;
          yield { delta: '  - Half-written replacement.', done: false };
          await new Promise<void>((resolve) => {
            if (opts.signal.aborted) resolve();
            else opts.signal.addEventListener('abort', () => {
              fake.partialAborted = true;
              resolve();
            }, { once: true });
          });
          return;
        }
        if (fake.calls === 2) {
          fake.wholePrompt = opts.messages.at(-1)?.content ?? '';
          yield { delta: WHOLE, done: false };
          yield { delta: '', done: true };
          return;
        }
        yield { delta: WHOLE, done: false };
        yield { delta: '', done: true };
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
    versions: [{ header: 'Topic', body: ORIGINAL, createdAt: 0, generatedBy: 'term-click' }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('supersede', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
  useGraphStore.getState().setActiveProjectId(project.id);
});

afterEach(() => {
  resetGenerationSessionsForTests();
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('whole rewrite superseding a partial rewrite', () => {
  it('replaces the draft and uses the last completed body as input', async () => {
    const partial = expandPart('n0', { kind: 'bullet', index: 0 });
    await vi.waitFor(() => expect(fake.partialStarted).toBe(true));

    await elaborateNode('n0');
    await partial;

    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(fake.partialAborted).toBe(true);
    expect(fake.wholePrompt).toContain(ORIGINAL);
    expect(fake.wholePrompt).not.toContain('Half-written replacement');
    expect(node.versions).toHaveLength(2);
    expect(node.versions[0]!.body).toBe(ORIGINAL);
    expect(node.versions[1]!.body).toBe(WHOLE);
  });
});
