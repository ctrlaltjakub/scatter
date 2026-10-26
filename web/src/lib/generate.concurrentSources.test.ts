import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { expandPart } from './generate';

const BODY = `Opening fact⟦1⟧ remains.

- First area
  - First old detail.
- Second area
  - Second old detail.`;

vi.mock('@/providers/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...orig,
    getAdapter: () => ({
      listModels: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamChat(_key: string, opts: { messages: { content: string }[] }) {
        const system = opts.messages[0]?.content ?? '';
        const prompt = opts.messages.at(-1)?.content ?? '';
        if (system.includes('REQUIRED RESPONSE FORMAT')) {
          yield { delta: '{"terms":[]}', done: false };
          yield { delta: '', done: true };
          return;
        }
        const marked = prompt.match(/<<<EXPAND>>>\n([\s\S]*?)\n<<<END>>>/)?.[1] ?? '';
        if (marked.includes('First old detail')) {
          const text = '  - First old detail, plus first expanded evidence.';
          yield { delta: text, done: false };
          yield {
            delta: '', done: true,
            citations: [{ url: 'https://first.example/source', title: 'First', startIndex: 0, endIndex: text.length }],
          };
          return;
        }
        if (marked.includes('Second old detail')) {
          const text = '  - Second old detail, plus second expanded evidence.';
          yield { delta: text, done: false };
          yield {
            delta: '', done: true,
            citations: [{ url: 'https://second.example/source', title: 'Second', startIndex: 0, endIndex: text.length }],
          };
          return;
        }
        throw new Error(`Unexpected prompt: ${prompt}`);
      },
      capabilities: {},
    }),
  };
});

beforeEach(() => {
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'sk-test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    webSearch: true,
  });
  const node: ScatterNode = {
    id: 'n0', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    versions: [{
      header: 'Topic', body: BODY, createdAt: 0, generatedBy: 'term-click',
      sources: [{ n: 1, url: 'https://old.example/source', title: 'Old' }],
      contentType: 'encyclopedic',
    }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('concurrent-sources', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
  useGraphStore.getState().setActiveProjectId(project.id);
});

afterEach(() => {
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('concurrent partial rewrite sources', () => {
  it('does not leave a provisional version when the requested section is absent', async () => {
    await expandPart('n0', { kind: 'bullet', index: 99 });
    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.versions).toHaveLength(1);
    expect(node.currentVersionIndex).toBe(0);
    expect(node.generating).not.toBe(true);
  });

  it('allocates unique numbers and commits every partial citation once', async () => {
    await Promise.all([
      expandPart('n0', { kind: 'bullet', index: 0 }),
      expandPart('n0', { kind: 'bullet', index: 1 }),
    ]);

    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.versions).toHaveLength(2);
    const version = node.versions[1]!;
    expect(version.sources?.map((s) => [s.n, s.url])).toEqual([
      [1, 'https://old.example/source'],
      [2, 'https://first.example/source'],
      [3, 'https://second.example/source'],
    ]);
    expect(version.body).toContain('evidence.⟦2⟧');
    expect(version.body).toContain('evidence.⟦3⟧');
  });
});
