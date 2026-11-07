import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { FactCheckReport, ScatterNode } from '@/store/types';
import { factCheckAvailability, startFactCheck } from './factCheck';
import { rewriteNodeWithEvidence } from './generate';

const fake = vi.hoisted(() => ({
  messages: [] as string[],
  reset() { this.messages = []; },
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...original,
    getAdapter: () => ({
      listModels: async () => [],
      capabilities: { webSearch: true },
      async *streamChat(_key: string, opts: { messages: { content: string }[]; webSearch: boolean }) {
        const prompt = opts.messages.map((message) => message.content).join('\n');
        fake.messages.push(prompt);
        if (/REQUIRED RESPONSE FORMAT/i.test(prompt)) {
          yield {
            delta: '{"terms":["corrected claim","Evidence","Finding"]}',
            done: false,
          };
        } else {
          expect(opts.webSearch).toBe(false);
          yield {
            delta: prompt.includes('| Shape |') ? '| Shape | Perimeter |\n| --- | --- |\n| Triangle | 12 cm⟪E1⟫ |' : 'The corrected claim is supported⟪E1⟫.\n\n- Evidence\n  - Finding: The source supports it⟪E1⟫.',
            done: false,
          };
        }
        yield { delta: '', done: true };
      },
    }),
  };
});
const report: FactCheckReport = {
  schemaVersion: 1,
  bodyFingerprint: 'fingerprint',
  versionCreatedAt: 1,
  providerId: 'p1',
  model: 'm',
  startedAt: 1,
  completedAt: 2,
  complete: true,
  failedUnitIds: [],
  units: [{
    id: 'opening:0',
    order: 0,
    stage: 'opening',
    kind: 'sentence',
    sentenceIndex: 0,
    text: 'The old claim is true.',
    state: 'complete',
    finding: {
      verdict: 'contradicted',
      explanation: 'The evidence supports a corrected claim instead.',
      googleSearchSuggestions: ['<div>Google evidence attribution</div>'],
      evidence: [{
        url: 'https://evidence.example/source',
        title: 'Evidence source',
        domain: 'evidence.example',
        stance: 'contradicts',
        excerpt: 'The corrected claim is supported.',
        excerptOrigin: 'source',
      }],
    },
  }],
};

beforeEach(() => {
  fake.reset();
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'key', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    webSearch: true,
    outputTokenCap: 4000,
  });
  const node: ScatterNode = {
    id: 'n1',
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{
      header: 'Claim',
      body: 'The old claim is true.\n\n- Old\n  - Detail: Old detail.',
      createdAt: 1,
      generatedBy: 'term-click',
      contentType: 'encyclopedic',
      factCheck: { complete: report },
    }],
    currentVersionIndex: 0,
  };
  const parent: ScatterNode = {
    id: 'parent',
    type: 'root',
    position: { x: -500, y: 0 },
    frozen: false,
    versions: [{
      header: 'SECRET PARENT',
      body: 'ANCESTOR CONTENT MUST NOT APPEAR',
      createdAt: 0,
      generatedBy: 'root',
    }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('facts', parent.id);
  useGraphStore.getState().setProject({
    ...project,
    nodes: { parent, n1: node },
    arrows: {
      a1: { id: 'a1', kind: 'auto', fromNodeId: 'parent', toNodeId: 'n1' },
    },
    selection: ['n1'],
  });
  useGraphStore.getState().setActiveProjectId(project.id);
});

afterEach(() => {
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('rewrite with evidence', () => {
  it.each(['encyclopedic', 'explain', 'answer'] as const)('never starts an evidence job for an empty %s, even without a placeholder flag', async contentType => {
    const node = useGraphStore.getState().project!.nodes.n1!;
    const blank = { ...node.versions[0]!, body: '  \n ', contentType, markdownNote: contentType === 'answer', factCheck: undefined };
    useGraphStore.getState().updateNode(node.id, { versions: [blank] });
    expect(factCheckAvailability(blank)).toMatchObject({ available: false, reason: expect.stringMatching(/add text/i) });
    await startFactCheck(node.id);
    expect(useGraphStore.getState().project!.nodes.n1!.versions[0]?.factCheck).toBeUndefined();
    expect(fake.messages).toEqual([]);
  });

  it.each([true, false])('preserves the detached Markdown format, language and source version (note: %s)', async markdownNote => {
    const node = useGraphStore.getState().project!.nodes.n1!;
    const original = { ...node.versions[0]!, contentType: 'answer' as const, markdownNote, language: 'ar' as const,
      body: '| Shape | Perimeter |\n| --- | --- |\n| Triangle | 11 cm |',
      chat: { turnId: 'turn', title: 'Shapes', question: '', informationChunking: false, contextPath: [], state: 'complete' as const } };
    useGraphStore.getState().updateNode(node.id, { versions: [original] });
    await rewriteNodeWithEvidence(node.id, report);
    const versions = useGraphStore.getState().project!.nodes.n1!.versions;
    expect(versions[0]).toEqual(original);
    expect(versions[1]).toMatchObject({ markdownNote, contentType: 'answer', language: 'ar', chat: { turnId: 'turn' },
      sources: [{ url: 'https://evidence.example/source' }] });
    expect(versions[1]?.body).toContain('12 cm⟦1⟧');
    expect(versions[1]?.factCheck).toBeUndefined();
    expect(fake.messages[0]).toContain('Markdown learning answer');
  });
  it('creates one unchecked version, performs no search, excludes ancestors, and converts evidence tokens to sources', async () => {
    await rewriteNodeWithEvidence('n1', report);
    const node = useGraphStore.getState().project!.nodes.n1!;
    expect(node.versions).toHaveLength(2);
    const rewritten = node.versions[1]!;
    expect(rewritten.factCheck).toBeUndefined();
    expect(rewritten.googleSearchSuggestions).toEqual(['<div>Google evidence attribution</div>']);
    expect(rewritten.header).toBe('Claim');
    expect(rewritten.body).toContain('⟦1⟧');
    expect(rewritten.body).not.toContain('⟪E1⟫');
    expect(rewritten.sources).toEqual([{
      n: 1,
      url: 'https://evidence.example/source',
      title: 'Evidence source',
      domain: 'evidence.example',
    }]);
    expect(fake.messages.join('\n')).not.toContain('SECRET PARENT');
    expect(fake.messages.join('\n')).not.toContain('ANCESTOR CONTENT');
    expect(fake.messages.join('\n')).not.toContain('Google evidence attribution');
  });
});
