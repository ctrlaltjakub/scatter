import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useFactCheckTaskStore } from '@/store/useFactCheckTaskStore';
import type { ScatterNode } from '@/store/types';
import { startFactCheck, stopFactCheck } from './factCheck';

const fake = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  calls: [] as string[],
  systems: [] as string[],
  missSearchOnce: false,
  reset() {
    this.active = 0;
    this.maxActive = 0;
    this.calls = [];
    this.systems = [];
    this.missSearchOnce = false;
  },
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...original,
    modelSupportsWebSearch: () => true,
    getAdapter: () => ({
      listModels: async () => [],
      capabilities: { webSearch: true },
      async *streamChat(_key: string, opts: { messages: { content: string }[] }) {
        fake.systems.push(opts.messages[0]?.content ?? '');
        const prompt = opts.messages.at(-1)?.content ?? '';
        const unitId = /Passage ID:\s*([^\n]+)/.exec(prompt)?.[1]?.trim() ?? 'unknown';
        fake.calls.push(unitId);
        fake.active += 1;
        fake.maxActive = Math.max(fake.maxActive, fake.active);
        await new Promise((resolve) => setTimeout(resolve, 4));
        fake.active -= 1;
        if (fake.missSearchOnce) {
          fake.missSearchOnce = false;
          yield {
            delta: JSON.stringify({
              unitId,
              verdict: 'unverified',
              unverifiedReason: 'insufficient_evidence',
              explanation: 'No search.',
              evidence: [],
            }),
            done: false,
          };
          yield { delta: '', done: true };
          return;
        }
        const url = `https://evidence.example/${encodeURIComponent(unitId)}`;
        yield {
          delta: '',
          done: false,
          citations: [{ url, title: 'Evidence', content: 'The evidence supports this passage.' }],
          webSearch: { used: true, requestCount: 1 },
          googleSearchSuggestions: ['<div>Google Search</div>'],
        };
        yield {
          delta: JSON.stringify({
            unitId,
            verdict: 'supported',
            unverifiedReason: null,
            explanation: 'The searched evidence supports the passage.',
            evidence: [{
              url,
              title: 'Evidence',
              stance: 'supports',
              excerpt: 'evidence supports this passage',
            }],
          }),
          done: false,
        };
        yield { delta: '', done: true };
      },
    }),
  };
});
function setNode(body: string): void {
  const node: ScatterNode = {
    id: 'n1',
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{
      header: 'Claims',
      body,
      createdAt: 1,
      generatedBy: 'term-click',
      contentType: 'encyclopedic',
    }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('facts', node.id);
  useGraphStore.getState().setProject({
    ...project,
    nodes: { [node.id]: node },
    selection: [node.id],
  });
  useGraphStore.getState().setActiveProjectId(project.id);
}

beforeEach(() => {
  fake.reset();
  useSettingsStore.setState({
    providers: [{
      id: 'p1',
      preset: 'openrouter',
      apiKey: 'key',
      enabledModels: ['model'],
    }],
    activeModelRef: { providerId: 'p1', model: 'model' },
    reasoningEffort: 'low',
    outputTokenCap: 4000,
  });
  useCitationPanelStore.getState().close();
  useFactCheckTaskStore.setState({ tasks: {} });
});

afterEach(() => {
  stopFactCheck('n1', 1);
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('streaming fact-check lifecycle', () => {
  it('keeps fact-check explanations in the source version language', async () => {
    setNode('هذه حقيقة قابلة للتحقق.');
    const node = useGraphStore.getState().project!.nodes.n1!;
    useGraphStore.getState().updateNode('n1', { versions: [{ ...node.versions[0]!, language: 'ar' }] });
    useSettingsStore.setState({ generationLanguage: 'ja' });
    await startFactCheck('n1');
    expect(fake.systems[0]).toContain('Arabic (Modern Standard) (ar)');
    expect(fake.systems[0]).not.toContain('Japanese (ja-JP)');
  });
  it('opens pending review immediately, caps global work at ten, and runs bullets after opening prose', async () => {
    const opening = Array.from({ length: 13 }, (_, i) => `Claim ${i + 1} is factual.`).join(' ');
    setNode(`${opening}\n\n- Section\n  - Child: A described claim.`);
    const pending = startFactCheck('n1');

    const during = useGraphStore.getState().project!.nodes.n1!.versions[0]!;
    expect(during.factCheck?.pending?.units).toHaveLength(14);
    expect(during.factCheck?.pending?.units.every((unit) => unit.state === 'pending')).toBe(true);
    expect(useCitationPanelStore.getState()).toMatchObject({
      mode: 'fact-check',
      nodeId: 'n1',
      factVersionCreatedAt: 1,
      activeFactUnitId: 'opening:0',
    });

    await pending;
    const complete = useGraphStore.getState().project!.nodes.n1!.versions[0]!.factCheck?.complete;
    expect(complete?.complete).toBe(true);
    expect(complete?.units.every((unit) => unit.state === 'complete')).toBe(true);
    expect(complete?.units[0]?.finding?.googleSearchSuggestions).toEqual(['<div>Google Search</div>']);
    expect(fake.maxActive).toBeLessThanOrEqual(10);
    const firstBulletCall = fake.calls.findIndex((id) => id.startsWith('bullet:'));
    expect(firstBulletCall).toBeGreaterThanOrEqual(13);
  });

  it('retries one answer that lacks confirmed search activity', async () => {
    fake.missSearchOnce = true;
    setNode('One factual sentence.');
    await startFactCheck('n1');
    expect(fake.calls).toEqual(['opening:0', 'opening:0']);
    expect(
      useGraphStore.getState().project!.nodes.n1!.versions[0]!.factCheck?.complete
        ?.units[0]?.finding?.verdict,
    ).toBe('supported');
  });
});
