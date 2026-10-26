import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { expandPart } from './generate';

const BODY = `Opening.

- First
  - First old detail.
- Second
  - Second old detail.`;

vi.mock('@/providers/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...orig,
    getAdapter: () => ({
      listModels: async () => [],
      async *streamChat(_key: string, opts: { messages: { content: string }[] }) {
        const system = opts.messages[0]?.content ?? '';
        const prompt = opts.messages.at(-1)?.content ?? '';
        if (system.includes('REQUIRED RESPONSE FORMAT')) {
          yield { delta: '{"terms":[]}', done: false };
          yield { delta: '', done: true };
          return;
        }
        const marked = prompt.match(/<<<EXPAND>>>\n([\s\S]*?)\n<<<END>>>/)?.[1] ?? '';
        if (marked.includes('Second old detail')) throw new Error('second expansion failed');
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield { delta: '  - First expanded.', done: false };
        yield { delta: '', done: true };
      },
      capabilities: {},
    }),
  };
});

beforeEach(() => {
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'sk-test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    webSearch: false,
  });
  const node: ScatterNode = {
    id: 'n0', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: 'Topic', body: BODY, createdAt: 0, generatedBy: 'term-click' }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('concurrent-failure', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
  useGraphStore.getState().setActiveProjectId(project.id);
});

afterEach(() => {
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('concurrent partial failure', () => {
  it('restores a failed section with no model text while another section completes', async () => {
    await Promise.all([
      expandPart('n0', { kind: 'bullet', index: 0 }),
      expandPart('n0', { kind: 'bullet', index: 1 }),
    ]);
    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.versions).toHaveLength(2);
    expect(node.versions[1]!.body).toContain('First expanded.');
    expect(node.versions[1]!.body).toContain('Second old detail.');
  });
});
