import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { expandPart } from './generate';

const fake = vi.hoisted(() => ({
  calls: 0,
  systemPrompts: [] as string[],
  reset() { this.calls = 0; this.systemPrompts = []; },
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...orig,
    getAdapter: () => ({
      listModels: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamChat(_key: string, opts: { messages: { role: string; content: string }[] }) {
        fake.calls++;
        fake.systemPrompts.push(opts.messages[0]?.content ?? '');
        if (fake.calls === 1) {
          yield { delta: 'Old fact⟦1⟧ remains, with additional detail.', done: false };
        } else {
          yield { delta: 'Old [[fact]]⟦1⟧ remains, with [[additional detail]].', done: false };
        }
        yield { delta: '', done: true };
      },
      capabilities: {},
    }),
  };
});

beforeEach(() => {
  fake.reset();
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'sk-test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    webSearch: false,
  });
  const node: ScatterNode = {
    id: 'n0', type: 'explain', position: { x: 0, y: 0 }, frozen: false,
    versions: [{
      header: 'Topic - explained', body: 'Old fact⟦1⟧ remains.', createdAt: 0, generatedBy: 'explain',
      sources: [{ n: 1, url: 'https://old.example/source' }],
      width: 520, bodyMaxHeight: 280, contentType: 'explain',
    }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('expand-explain', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
  useGraphStore.getState().setActiveProjectId(project.id);
});

afterEach(() => {
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('expand explain generation', () => {
  it('uses prose prompting, appends one version, and preserves citations and sizing', async () => {
    await expandPart('n0', { kind: 'freetext' });
    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.generationError, JSON.stringify(node)).toBeUndefined();
    expect(node.versions).toHaveLength(2);
    const version = node.versions[1]!;
    expect(fake.systemPrompts[0]).toContain('new to this field');
    expect(version.body).not.toMatch(/^\s*[-*+]\s/m);
    expect(version.sources).toEqual([{ n: 1, url: 'https://old.example/source' }]);
    expect(version).toEqual(expect.objectContaining({
      header: 'Topic - explained', contentType: 'explain', width: 520, bodyMaxHeight: 280,
    }));
  });

  it('expands only interactive prose and preserves the existing program', async () => {
    const project = useGraphStore.getState().project!;
    const original = project.nodes.n0!;
    const interactive = {
      html: '<!doctype html><html><body style="background:var(--sc-bg);color:var(--sc-text);border-color:var(--sc-primary)">program</body></html>',
      request: 'Topic',
      providerId: 'p1',
      model: 'm',
      viewportWidth: 960,
      viewportHeight: 720,
    };
    useGraphStore.getState().setProject({
      ...project,
      nodes: {
        n0: {
          ...original,
          versions: [{
            ...original.versions[0]!,
            contentType: 'interactive',
            generatedBy: 'interactive',
            interactive,
          }],
        },
      },
    });

    await expandPart('n0', { kind: 'freetext' });

    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.versions).toHaveLength(2);
    expect(node.versions[1]).toEqual(expect.objectContaining({
      contentType: 'interactive',
      interactive,
    }));
    expect(node.versions[1]!.body).not.toMatch(/^\s*[-*+]\s/m);
  });
});
