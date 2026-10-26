import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { modifySelection } from './generate';

const BODY = `Opening repeated.\n\n- Topic\n  - First: repeated alpha\n  - Second: repeated beta`;
const fake = vi.hoisted(() => ({
  prompts: [] as string[],
  releaseMain: null as null | (() => void),
  releaseChips: null as null | (() => void),
  mainOutput: 'changed beta',
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...orig,
    getAdapter: () => ({
      listModels: async () => [],
      async *streamChat(_key: string, opts: { messages: { content: string }[] }) {
        const system = opts.messages[0]?.content ?? '';
        const prompt = opts.messages.at(-1)?.content ?? '';
        fake.prompts.push(prompt);
        if (system.includes('REQUIRED RESPONSE FORMAT')) {
          await new Promise<void>((resolve) => { fake.releaseChips = resolve; });
          yield {
            delta: '{"terms":["changed beta","First revised","Second revised"]}',
            done: false,
          };
        } else {
          await new Promise<void>((resolve) => { fake.releaseMain = resolve; });
          yield { delta: fake.mainOutput, done: false };
        }
        yield { delta: '', done: true };
      },
      capabilities: {},
    }),
  };
});

beforeEach(() => {
  fake.prompts = [];
  fake.releaseMain = null;
  fake.releaseChips = null;
  fake.mainOutput = 'changed beta';
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'sk-test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    webSearch: false,
  });
  const node: ScatterNode = {
    id: 'n0', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: 'Topic', body: BODY, createdAt: 0, generatedBy: 'term-click', width: 500 }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('modify-selection', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { n0: node } });
  useGraphStore.getState().setActiveProjectId(project.id);
});

afterEach(() => {
  fake.releaseMain?.();
  fake.releaseChips?.();
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('modifySelection', () => {
  it('keeps one selected fragment unchanged through generation and term marking', async () => {
    const start = BODY.lastIndexOf('repeated beta');
    const operation = modifySelection({
      nodeId: 'n0', versionIndex: 0, sourceBody: BODY,
      start, end: start + 'repeated beta'.length, text: 'repeated beta',
      parts: [{
        sourceField: 'b:0:c:1:desc',
        start,
        end: start + 'repeated beta'.length,
        text: 'repeated beta',
      }],
    }, 'make it different');

    await vi.waitFor(() => expect(useGraphStore.getState().project!.nodes.n0!.versions).toHaveLength(2));
    await vi.waitFor(() => expect(fake.releaseMain).not.toBeNull());
    expect(useGraphStore.getState().project!.nodes.n0!.versions[1]!.body).toBe(BODY);
    fake.releaseMain!();
    await vi.waitFor(() => expect(fake.releaseChips).not.toBeNull());
    expect(useGraphStore.getState().project!.nodes.n0!.versions[1]!.body).toBe(BODY);
    fake.releaseChips!();
    await operation;

    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.versions).toHaveLength(2);
    expect(node.versions[1]!.body).toBe(BODY.slice(0, start) + '[[changed beta]]' + BODY.slice(start + 'repeated beta'.length));
    expect(node.versions[1]).toMatchObject({ width: 500, generatedBy: 'modify' });
    expect(fake.prompts[0]).toContain('make it different');
    expect(fake.prompts[0]).toContain('<<<SELECTED>>>repeated beta<<<END_SELECTED>>>');
  });

  it('modifies several visible titles independently without touching hidden descriptions', async () => {
    const firstStart = BODY.indexOf('First');
    const secondStart = BODY.indexOf('Second');
    fake.mainOutput = [
      '<<<REPLACEMENT_1>>>First revised<<<END_REPLACEMENT_1>>>',
      '<<<REPLACEMENT_2>>>Second revised<<<END_REPLACEMENT_2>>>',
    ].join('\n');

    const operation = modifySelection({
      nodeId: 'n0', versionIndex: 0, sourceBody: BODY,
      start: firstStart, end: secondStart + 'Second'.length,
      text: 'First\nSecond',
      parts: [
        { sourceField: 'b:0:c:0:name', start: firstStart, end: firstStart + 'First'.length, text: 'First' },
        { sourceField: 'b:0:c:1:name', start: secondStart, end: secondStart + 'Second'.length, text: 'Second' },
      ],
    }, 'make both titles clearer');

    await vi.waitFor(() => expect(useGraphStore.getState().project!.nodes.n0!.versions).toHaveLength(2));
    await vi.waitFor(() => expect(fake.releaseMain).not.toBeNull());
    expect(useGraphStore.getState().project!.nodes.n0!.versions[1]!.body).toBe(BODY);
    fake.releaseMain!();
    await vi.waitFor(() => expect(fake.releaseChips).not.toBeNull());
    expect(useGraphStore.getState().project!.nodes.n0!.versions[1]!.body).toBe(BODY);
    fake.releaseChips!();
    await operation;

    const revised = useGraphStore.getState().project!.nodes.n0!.versions[1]!.body;
    expect(revised).toBe(BODY
      .replace('First', '[[First revised]]')
      .replace('Second', '[[Second revised]]'));
    expect(revised).toContain('repeated alpha');
    expect(revised).toContain('repeated beta');
    expect(fake.prompts[0]).toContain('<<<SELECTED_1>>>First<<<END_SELECTED_1>>>');
    expect(fake.prompts[0]).toContain('<<<SELECTED_2>>>Second<<<END_SELECTED_2>>>');
    expect(fake.prompts[0]).toContain('make both titles clearer');
  });

  it('keeps the source body when the model omits one selected replacement', async () => {
    const firstStart = BODY.indexOf('First');
    const secondStart = BODY.indexOf('Second');
    fake.mainOutput = '<<<REPLACEMENT_1>>>First revised<<<END_REPLACEMENT_1>>>';
    const operation = modifySelection({
      nodeId: 'n0', versionIndex: 0, sourceBody: BODY,
      start: firstStart, end: secondStart + 'Second'.length,
      text: 'First\nSecond',
      parts: [
        { sourceField: 'b:0:c:0:name', start: firstStart, end: firstStart + 5, text: 'First' },
        { sourceField: 'b:0:c:1:name', start: secondStart, end: secondStart + 6, text: 'Second' },
      ],
    }, 'rename both');

    await vi.waitFor(() => expect(fake.releaseMain).not.toBeNull());
    fake.releaseMain!();
    await operation;

    const node = useGraphStore.getState().project!.nodes.n0!;
    expect(node.versions[1]!.body).toBe(BODY);
    expect(node.generationError).toMatch(/every selected-text replacement/i);
  });
});
