import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { isEmptyTextNode, spawnEmptyTextNode } from './emptyNodes';
import { generateEmptyTextNode } from './generate';
import { MIN_NODE_W, APPROX_HEADER_CHROME } from './nodeSize';

vi.mock('./termPreviews', () => ({ generateTermPreviews: vi.fn(async () => {}) }));
vi.mock('./wikimediaDiscovery', () => ({ startWikimediaDiscovery: vi.fn(async () => {}) }));
const requests = vi.hoisted(() => ({ count: 0, gate: null as Promise<void> | null }));
vi.mock('@/providers/registry', async original => ({ ...await original<typeof import('@/providers/registry')>(),
  getAdapter: () => ({ async *streamChat(_key: string, options: { messages: { content: string }[] }) {
    requests.count++;
    if (requests.gate) await requests.gate;
    yield { delta: options.messages[0]!.content.includes('REQUIRED RESPONSE FORMAT') ? '{"terms":[]}'
      : 'Light carries **energy**.\n\n- **Waves**\n  - Frequency: The number of cycles.\n  - Wavelength: The distance between peaks.\n- **Matter**\n  - Absorption: Transfers energy.\n  - Reflection: Changes direction.', done: true };
  } }),
}));
beforeEach(() => {
  requests.count = 0;
  requests.gate = null;
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, providers: [{ id: 'p', preset: 'custom', apiKey: 'test', enabledModels: ['m'] }], activeModelRef: { providerId: 'p', model: 'm' } });
  const project = createBlankProject('Example', 'root');
  project.nodes.root = { id: 'root', type: 'root', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: 'Physics', body: 'Physics studies nature.', generatedBy: 'root', createdAt: 1 }], currentVersionIndex: 0 };
  useGraphStore.setState({ project, activeProjectId: project.id });
  useGraphStore.temporal.getState().clear();
});
describe('blank text node lifecycle', () => {
  it('makes an empty explain card half as tall as an empty encyclopedic card', () => {
    const explain = spawnEmptyTextNode('root', 'explain')!;
    const encyclopedic = spawnEmptyTextNode('root', 'encyclopedic')!;
    const nodes = useGraphStore.getState().project!.nodes;
    const explainHeight = nodes[explain]!.versions[0]!.bodyMaxHeight! + APPROX_HEADER_CHROME;
    const encyclopedicHeight = nodes[encyclopedic]!.versions[0]!.bodyMaxHeight! + APPROX_HEADER_CHROME;
    expect(explainHeight).toBe(encyclopedicHeight / 2);
  });
  it.each(['encyclopedic', 'explain'] as const)('creates %s at minimum width, generates in place, and restores the blank with undo', async type => {
    const id = spawnEmptyTextNode('root', type)!;
    const read = () => useGraphStore.getState().project!.nodes[id]!;
    expect(isEmptyTextNode(read())).toBe(true);
    expect(read().versions[0]).toMatchObject({ width: MIN_NODE_W, minWidth: MIN_NODE_W, contentType: type });
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    await generateEmptyTextNode(id, 'What is light?');
    expect(Object.keys(useGraphStore.getState().project!.nodes)).toHaveLength(2);
    expect(read().versions).toHaveLength(1);
    expect(read().versions[0]?.body).toContain('Light carries');
    expect(read().versions[0]?.contentType).toBe(type);
    expect(read().versions[0]?.initialTextFrame).toBeUndefined();
    expect(isEmptyTextNode(read())).toBe(false);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(2);
    useGraphStore.temporal.getState().undo();
    expect(isEmptyTextNode(read())).toBe(true);
    useGraphStore.temporal.getState().undo();
    expect(read()).toBeUndefined();
  });
  it('does not turn an unconfigured blank into a broken generated node', async () => {
    const id = spawnEmptyTextNode('root', 'explain')!;
    useSettingsStore.setState({ activeModelRef: null });
    await generateEmptyTextNode(id, 'Gravity');
    expect(isEmptyTextNode(useGraphStore.getState().project!.nodes[id]!)).toBe(true);
    expect(requests.count).toBe(0);
  });
  it('does not write a late reply over the blank restored by undo', async () => {
    let release!: () => void;
    requests.gate = new Promise<void>(resolve => { release = resolve; });
    const id = spawnEmptyTextNode('root', 'explain')!;
    const running = generateEmptyTextNode(id, 'Gravity');
    await vi.waitFor(() => expect(requests.count).toBe(1));
    useGraphStore.temporal.getState().undo();
    expect(isEmptyTextNode(useGraphStore.getState().project!.nodes[id]!)).toBe(true);
    release();
    await running;
    const restored = useGraphStore.getState().project!.nodes[id]!;
    expect(restored.versions[0]?.body).toBe('');
    expect(isEmptyTextNode(restored)).toBe(true);
    expect(restored.generationError).toBeUndefined();
  });
});
