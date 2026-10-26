import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import type { NodeTextSelection } from '@/store/useNodeTextSelectionStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  classifyFollowUpIntent,
  generateTextVersionFromHeader,
  modifyNode,
  regenerateNode,
  retypeNodeToText,
  saveManualEdit,
  selectedQuestionHeader,
  spawnExplain,
  spawnFollowUp,
  spawnTermClick,
} from './generate';
import { INTERACTIVE_NODE_W } from './nodeSize';
import { INTERACTIVE_VIEWPORT_HEIGHT, INTERACTIVE_VIEWPORT_WIDTH } from './interactiveDocument';

const BODY = `A compact opening paragraph.

- Alpha
  - one: First detail
  - two: Second detail
- Beta
  - one: Third detail
  - two: Fourth detail`;

const fake = vi.hoisted(() => ({
  classifier: 'explore' as 'explore' | 'explain' | 'interactive',
  prompts: [] as string[],
  models: [] as string[],
  interactiveOptions: [] as Array<{ maxOutputTokens?: number; reasoningEffort?: string }>,
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...original,
    getAdapter: () => ({
      listModels: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamChat(_key: string, opts: {
        model: string;
        messages: { content: string }[];
        maxOutputTokens?: number;
        reasoningEffort?: string;
      }) {
        const system = opts.messages[0]?.content ?? '';
        const user = opts.messages.at(-1)?.content ?? '';
        fake.prompts.push(user);
        fake.models.push(opts.model);
        if (system.includes("route a user's follow-up")) {
          yield { delta: fake.classifier, done: false };
        } else if (system.includes('self-contained interactive learning document')) {
          fake.interactiveOptions.push({
            maxOutputTokens: opts.maxOutputTokens,
            reasoningEffort: opts.reasoningEffort,
          });
          yield { delta: '<!doctype html><html><head></head><body style="background:var(--sc-bg);color:var(--sc-text)"><button style="border-color:var(--sc-primary)">Try it</button></body></html>', done: false };
        } else if (system.includes('REQUIRED RESPONSE FORMAT')) {
          yield { delta: '{"terms":[]}', done: false };
        } else if (system.includes('Explain the given concept clearly')) {
          yield { delta: '**Clear language** makes the selected idea understandable.', done: false };
        } else {
          yield { delta: BODY, done: false };
        }
        yield { delta: '', done: true };
      },
      capabilities: {},
    }),
  };
});

const parent: ScatterNode = {
  id: 'parent',
  type: 'root',
  position: { x: 0, y: 0 },
  frozen: true,
  versions: [{ header: 'Parent', body: BODY, createdAt: 100, generatedBy: 'root' }],
  currentVersionIndex: 0,
};

const selectedStart = BODY.indexOf('opening paragraph');
const exactSelection: NodeTextSelection = {
  nodeId: 'parent',
  versionIndex: 0,
  sourceBody: BODY,
  start: selectedStart,
  end: selectedStart + 'opening paragraph'.length,
  text: 'opening paragraph',
  parts: [{
    sourceField: 'ft',
    start: selectedStart,
    end: selectedStart + 'opening paragraph'.length,
    text: 'opening paragraph',
  }],
};

function installLongSelectionParent(): { selection: NodeTextSelection; selectedText: string } {
  const selectedText = Array.from(
    { length: 30 },
    (_, index) => `selection-word-${index + 1}`,
  ).join(' ');
  const body = `${selectedText}\n\n- Alpha\n  - one: First detail\n  - two: Second detail`;
  const longParent: ScatterNode = {
    ...parent,
    versions: [{ ...parent.versions[0]!, body }],
  };
  const selection: NodeTextSelection = {
    nodeId: parent.id,
    versionIndex: 0,
    sourceBody: body,
    start: 0,
    end: selectedText.length,
    text: selectedText,
    parts: [{ sourceField: 'ft', start: 0, end: selectedText.length, text: selectedText }],
  };
  const project = createBlankProject('long selected question', parent.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [parent.id]: longParent } });
  useGraphStore.getState().setActiveProjectId(project.id);
  return { selection, selectedText };
}

function hasSelectedFollowUpPrompt(selectedText: string, question: string): boolean {
  return fake.prompts.some((prompt) => (
    prompt.includes(`The user highlighted this exact passage in the parent node:\n\n${selectedText}`)
    && prompt.includes(`user is asking a following thing: "${question}"`)
  ));
}

beforeEach(() => {
  fake.classifier = 'explore';
  fake.prompts = [];
  fake.models = [];
  fake.interactiveOptions = [];
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'sk-test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    secondaryModelRef: undefined,
    secondaryUseSameModel: true,
    webSearch: false,
  });
  const project = createBlankProject('selection spawn', parent.id);
  useGraphStore.getState().setProject({ ...project, nodes: { parent } });
  useGraphStore.getState().setActiveProjectId(project.id);
});

afterEach(() => {
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('selected-text child generation', () => {
  it('uses the independently selected routing model for classification', async () => {
    useSettingsStore.setState({
      providers: [
        { id: 'p1', preset: 'openrouter', apiKey: 'sk-main', enabledModels: ['main-model'] },
        { id: 'p2', preset: 'openrouter', apiKey: 'sk-router', enabledModels: ['routing-model'] },
      ],
      activeModelRef: { providerId: 'p1', model: 'main-model' },
      secondaryUseSameModel: false,
      secondaryModelRef: { providerId: 'p2', model: 'routing-model' },
    });

    await classifyFollowUpIntent('parent', 'Please explain this simply');

    expect(fake.models).toEqual(['routing-model']);
  });

  it('normalizes only internal header whitespace', () => {
    expect(selectedQuestionHeader(' chosen\n words ', ' why   now? ')).toBe('chosen words: why now?');
  });

  it('keeps the selected-text minimum when a long question exceeds the two-line target', () => {
    const selection = Array.from(
      { length: 30 },
      (_, index) => `selection-word-${index + 1}`,
    ).join(' ');
    const question = 'Why does this happen, and how does it affect the complete system over time?';

    const header = selectedQuestionHeader(selection, question);
    const excerpt = header.slice(0, header.indexOf(': '));
    const retained = excerpt.slice(0, -1);

    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(96);
    expect(selection.startsWith(retained)).toBe(true);
    expect(selection[retained.length]).toBe(' ');
    expect(header.endsWith(`: ${question}`)).toBe(true);
  });

  it('lets selected text borrow unused room when the complete question is short', () => {
    const selection = Array.from(
      { length: 30 },
      (_, index) => `selection-word-${index + 1}`,
    ).join(' ');

    const header = selectedQuestionHeader(selection, 'Why?');
    const excerpt = header.slice(0, header.indexOf(': '));

    expect(excerpt.length).toBeGreaterThan(96);
    expect(header.length).toBeLessThanOrEqual(128);
    expect(header.endsWith(': Why?')).toBe(true);
  });

  it('attaches a source anchor without a term label for selected Explore', async () => {
    const childId = await spawnTermClick('parent', exactSelection.text, {
      sourceSelection: exactSelection,
    });
    const arrow = Object.values(useGraphStore.getState().project!.arrows)
      .find((item) => item.toNodeId === childId)!;
    expect(arrow.label).toBeUndefined();
    expect(arrow.sourceSelection).toMatchObject({
      sourceVersionCreatedAt: 100,
      text: 'opening paragraph',
      parts: [{ sourceField: 'ft', text: 'opening paragraph' }],
    });
  });

  it('uses the selected passage and question in an encyclopedic follow-up header', async () => {
    const childId = await spawnFollowUp('parent', 'why does this happen?', exactSelection);
    const child = useGraphStore.getState().project!.nodes[childId]!;
    expect(child.versions[0]!.header).toBe('opening paragraph: why does this happen?');
    expect(child.versions[0]!.selectedTextQuestion).toBe('why does this happen?');
    const arrow = Object.values(useGraphStore.getState().project!.arrows)
      .find((item) => item.toNodeId === childId)!;
    expect(arrow.sourceSelection?.text).toBe('opening paragraph');
  });

  it('adds the explain suffix once after selected follow-up routing', async () => {
    fake.classifier = 'explain';
    const childId = await spawnFollowUp('parent', 'why?', exactSelection);
    const child = useGraphStore.getState().project!.nodes[childId]!;
    expect(child.versions[0]!.header).toBe('opening paragraph: why? - explained');
    const arrow = Object.values(useGraphStore.getState().project!.arrows)
      .find((item) => item.toNodeId === childId)!;
    expect(arrow.sourceSelection?.text).toBe('opening paragraph');
    expect(fake.prompts.some((prompt) => prompt.includes('Selected passage: opening paragraph'))).toBe(true);
    expect(fake.prompts.some((prompt) => prompt.includes('Question: why?'))).toBe(true);
  });

  it('never auto-routes a follow-up to an interactive explanation', async () => {
    fake.classifier = 'interactive';
    const childId = await spawnFollowUp('parent', 'show me how this changes', exactSelection);
    const child = useGraphStore.getState().project!.nodes[childId]!;
    const version = child.versions[0]!;
    expect(version.contentType).toBe('encyclopedic');
    expect(version.interactive).toBeUndefined();
  });

  it('stores the complete selected passage while keeping the explain parts separate', async () => {
    const selected = Array.from(
      { length: 30 },
      (_, index) => `selection-word-${index + 1}`,
    ).join(' ');
    const longBody = `${selected}\n\n- Alpha\n  - one: detail`;
    const longParent: ScatterNode = {
      ...parent,
      versions: [{ ...parent.versions[0]!, body: longBody }],
    };
    const longSelection: NodeTextSelection = {
      nodeId: parent.id,
      versionIndex: 0,
      sourceBody: longBody,
      start: 0,
      end: selected.length,
      text: selected,
      parts: [{ sourceField: 'ft', start: 0, end: selected.length, text: selected }],
    };
    const project = createBlankProject('long explain header', parent.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [parent.id]: longParent } });
    fake.classifier = 'explain';

    const childId = await spawnFollowUp(parent.id, 'Why?', longSelection);
    const header = useGraphStore.getState().project!.nodes[childId]!.versions[0]!.header;
    expect(header).toContain(selected);
    expect(header.endsWith(': Why? - explained')).toBe(true);
    expect(useGraphStore.getState().project!.nodes[childId]!.versions[0]!.headerParts)
      .toEqual({ subject: selected, question: 'Why?', suffix: 'explained' });
  });

  it('attaches the same source anchor to the direct Explain action', async () => {
    const childId = await spawnExplain('parent', exactSelection.text, {
      sourceSelection: exactSelection,
    });
    const arrow = Object.values(useGraphStore.getState().project!.arrows)
      .find((item) => item.toNodeId === childId)!;
    expect(arrow.sourceSelection?.text).toBe('opening paragraph');
    expect(arrow.label).toBeUndefined();
  });

  it('regenerates a selected-text follow-up from the complete passage and question', async () => {
    const { selection, selectedText } = installLongSelectionParent();
    const question = 'Why does this matter?';
    const childId = await spawnFollowUp(parent.id, question, selection);
    const initialHeader = useGraphStore.getState().project!.nodes[childId]!.versions[0]!.header;
    expect(initialHeader).toBe(`${selectedText}: Why does this matter?`);
    fake.prompts = [];

    await regenerateNode(childId);

    expect(hasSelectedFollowUpPrompt(selectedText, question)).toBe(true);
    expect(useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!.header).toBe(initialHeader);
  });

  it('converts a compact selected-text follow-up to Explain using the complete prompt', async () => {
    const { selection, selectedText } = installLongSelectionParent();
    const question = 'Why does this matter?';
    const childId = await spawnFollowUp(parent.id, question, selection);
    fake.prompts = [];

    await retypeNodeToText(childId, 'explain');

    expect(fake.prompts.some((prompt) => (
      prompt.includes(`Selected passage: ${selectedText}`)
      && prompt.includes(`Question: ${question}`)
    ))).toBe(true);
    expect(useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!.header)
      .toBe(`${selectedText}: Why does this matter? - explained`);
  });

  it('converts a compact selected-text explanation to Encyclopedic using the complete prompt', async () => {
    const { selection, selectedText } = installLongSelectionParent();
    const question = 'Explain the implications';
    fake.classifier = 'explain';
    const childId = await spawnFollowUp(parent.id, question, selection);
    fake.prompts = [];

    await retypeNodeToText(childId, 'encyclopedic');

    expect(hasSelectedFollowUpPrompt(selectedText, question)).toBe(true);
    const current = useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!;
    expect(current.header.endsWith(' - explained')).toBe(false);
    expect(current.header).toBe(`${selectedText}: Explain the implications`);
    expect(current.generatedBy).toBe('follow-up');
  });

  it('clears selected-text question context when the compact header is manually edited', async () => {
    const childId = await spawnFollowUp('parent', 'why does this happen?', exactSelection);
    expect(useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!.selectedTextQuestion)
      .toBe('why does this happen?');

    const current = useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!;
    saveManualEdit(childId, 'An intentionally different topic', current.body);

    expect(useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!.selectedTextQuestion)
      .toBeUndefined();
  });

  it('uses a manually edited header instead of restoring the original selected-text prompt', async () => {
    const childId = await spawnFollowUp('parent', 'why does this happen?', exactSelection);
    const current = useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!;
    saveManualEdit(childId, 'An intentionally different topic', current.body);
    fake.prompts = [];

    await regenerateNode(childId);

    expect(fake.prompts.some((prompt) => prompt.includes('An intentionally different topic'))).toBe(true);
    expect(fake.prompts.some((prompt) => prompt.includes('The user highlighted this exact passage')))
      .toBe(false);
  });

  it('preserves selected-text question context through an automatic modification', async () => {
    const childId = await spawnFollowUp('parent', 'why does this happen?', exactSelection);

    await modifyNode(childId, 'Make the answer more concrete.');

    expect(useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!.selectedTextQuestion)
      .toBe('why does this happen?');
  });

  it('clears selected-text question context in a full-text manual version', async () => {
    const childId = await spawnFollowUp('parent', 'why does this happen?', exactSelection);
    const current = useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!;

    saveManualEdit(childId, current.header, `${current.body}\n\nManual addition.`);

    expect(useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!.selectedTextQuestion)
      .toBeUndefined();
  });

  it('recovers the complete prompt for a legacy compact-header version and persists it forward', async () => {
    const { selection, selectedText } = installLongSelectionParent();
    const question = 'Why does this matter?';
    const childId = await spawnFollowUp(parent.id, question, selection);
    const child = useGraphStore.getState().project!.nodes[childId]!;
    const legacyVersions = child.versions.map((version) => ({
      ...version,
      header: selectedQuestionHeader(selectedText, question),
      headerParts: undefined,
      selectedTextQuestion: undefined,
    }));
    useGraphStore.getState().updateNode(childId, { versions: legacyVersions });
    fake.prompts = [];

    await regenerateNode(childId);

    expect(hasSelectedFollowUpPrompt(selectedText, question)).toBe(true);
    expect(useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!.selectedTextQuestion)
      .toBe(question);
  });

  it('does not guess selected-text context when a legacy header is not an exact automatic match', async () => {
    const { selection } = installLongSelectionParent();
    const childId = await spawnFollowUp(parent.id, 'Why does this matter?', selection);
    const child = useGraphStore.getState().project!.nodes[childId]!;
    useGraphStore.getState().updateNode(childId, {
      versions: [{
        ...child.versions[0]!,
        header: 'A deliberately unrelated title?',
        headerParts: undefined,
        selectedTextQuestion: undefined,
      }],
      currentVersionIndex: 0,
    });
    fake.prompts = [];

    await regenerateNode(childId);

    expect(fake.prompts.some((prompt) => prompt.includes('The user highlighted this exact passage')))
      .toBe(false);
  });

  it('generates from semantic header parts while retaining visual add-ons only on the version', async () => {
    const childId = await spawnFollowUp('parent', 'why does this happen?', exactSelection);
    fake.prompts = [];
    const parts = {
      prefix: 'Case study',
      subject: exactSelection.text,
      question: 'What changes next?',
      suffix: 'explained',
    };

    await generateTextVersionFromHeader(childId, parts);

    const current = useGraphStore.getState().project!.nodes[childId]!.versions.at(-1)!;
    expect(current).toMatchObject({
      header: `Case study: ${exactSelection.text}: What changes next? - explained`,
      headerParts: parts,
      selectedTextQuestion: 'What changes next?',
    });
    expect(hasSelectedFollowUpPrompt(exactSelection.text, 'What changes next?')).toBe(true);
    expect(fake.prompts.some((prompt) => prompt.includes('Case study'))).toBe(false);
    expect(fake.prompts.some((prompt) => prompt.includes(' - explained'))).toBe(false);
  });
});
