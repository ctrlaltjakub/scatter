/**
 * Pass 2 (term marking) applies chips in ONE shot.
 *
 * Contract: while the chip-marking stream runs, the node's body must stay
 * byte-identical (zero mid-stream rewrites — the per-frame progressive reveal
 * was the O(n²) main-thread killer on long nodes); the validated chip-marked
 * body lands in exactly one write when the stream completes. Fallbacks
 * (provider error, token-cap truncation) keep the plain body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { redoTermMarking } from './generate';

/* Fake provider: streamChat yields the chip-marked text in slow deltas and,
 * between deltas, records what the store holds RIGHT NOW (body + status) —
 * that's the mid-stream observation the one-shot contract is about. */
const fake = vi.hoisted(() => ({
  deltas: [] as string[],
  finishReason: undefined as string | null | undefined,
  throwAtDelta: -1,
  observedBodies: [] as string[],
  observedStatuses: [] as string[],
  reset() {
    this.deltas = [];
    this.finishReason = undefined;
    this.throwAtDelta = -1;
    this.observedBodies = [];
    this.observedStatuses = [];
  },
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...orig,
    getAdapter: () => ({
      listModels: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamChat() {
        for (let i = 0; i < fake.deltas.length; i++) {
          if (i === fake.throwAtDelta) throw new Error('provider exploded');
          yield { delta: fake.deltas[i]!, done: false };
          // Let the frame coalescer's delivery (rAF or its 100ms fallback)
          // land before we observe the store.
          await new Promise((r) => setTimeout(r, 120));
          fake.observedBodies.push(bodyOf('n0'));
          const st = useNodeStatusStore.getState().statuses['n0'];
          fake.observedStatuses.push(st && st.clearedAt === null ? st.text : '');
        }
        yield { delta: '', done: true, finishReason: fake.finishReason };
      },
      capabilities: {},
    }),
  };
});

const PLAIN =
  'Intro paragraph about testing chips.\n\n' +
  '- **Alpha**\n  - one: the first detail sentence\n' +
  '- **Beta**\n  - two: the second detail sentence';
const CHIPPED =
  'Intro paragraph about [[testing chips]].\n\n' +
  '- **Alpha**\n  - one: the [[first detail]] sentence\n' +
  '- **Beta**\n  - two: the [[second detail]] sentence';

function bodyOf(id: string): string {
  const n = useGraphStore.getState().project?.nodes[id];
  return n?.versions[n.currentVersionIndex]?.body ?? '';
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function seed(body: string): void {
  const node: ScatterNode = {
    id: 'n0',
    type: 'root',
    position: { x: 0, y: 0 },
    frozen: false,
    renderedHeight: 300,
    versions: [{ header: 'Test', body, createdAt: 0, generatedBy: 'root', width: 624, bodyMaxHeight: 228 }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('chip-pass', 'n0');
  useGraphStore.getState().setProject({ ...project, nodes: { n0: node } });
  useGraphStore.getState().setActiveProjectId(project.id);
  useGraphStore.temporal.getState().clear();
}

beforeEach(() => {
  fake.reset();
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'sk-test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    webSearch: false, secondaryUseSameModel: true, customPrompts: {},
  });
  seed(PLAIN);
});

afterEach(() => {
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
  useNodeStatusStore.setState({ statuses: {} });
});

describe('one-shot chip apply (pass 2)', () => {
  it('never rewrites the body while the marking stream is running', async () => {
    fake.deltas = chunk(JSON.stringify({ terms: ['testing chips', 'first detail', 'second detail'] }), 20);
    await redoTermMarking('n0');
    expect(fake.observedBodies.length).toBeGreaterThan(2);
    for (const b of fake.observedBodies) expect(b).toBe(PLAIN);
  });

  it('applies the full validated chip-marked body in exactly one write', async () => {
    fake.deltas = chunk(JSON.stringify({ terms: ['testing chips', 'first detail', 'second detail'] }), 20);
    const bodyLog: string[] = [];
    const unsub = useGraphStore.subscribe((s) => {
      const n = s.project?.nodes['n0'];
      const b = n?.versions[n.currentVersionIndex]?.body;
      if (typeof b === 'string' && b !== bodyLog[bodyLog.length - 1]) bodyLog.push(b);
    });
    try {
      await redoTermMarking('n0');
    } finally {
      unsub();
    }
    expect(bodyOf('n0')).toBe(CHIPPED);
    // Only the plain clone and the final chipped body may ever be observable —
    // no partially-chipped intermediate states.
    const foreign = bodyLog.filter((b) => b !== PLAIN && b !== CHIPPED);
    expect(foreign).toEqual([]);
    expect(bodyLog.filter((b) => b === CHIPPED)).toHaveLength(1);
  });

  it('keeps the plain body when the provider errors mid-stream', async () => {
    fake.deltas = chunk(JSON.stringify({ terms: ['testing chips', 'first detail', 'second detail'] }), 20);
    fake.throwAtDelta = 2;
    await redoTermMarking('n0');
    expect(bodyOf('n0')).toBe(PLAIN);
    expect(useGraphStore.getState().project?.nodes['n0']?.generating).toBeFalsy();
  });

  it("keeps the plain body when the stream hits the token cap (finishReason 'length')", async () => {
    fake.deltas = chunk('{"terms":["testing chips"]}', 12); // even valid JSON is rejected when truncated
    fake.finishReason = 'length';
    await redoTermMarking('n0');
    expect(bodyOf('n0')).toBe(PLAIN);
  });

  it('shows the MARKING TERMS status during the pass and clears it after', async () => {
    fake.deltas = chunk(JSON.stringify({ terms: ['testing chips', 'first detail', 'second detail'] }), 20);
    await redoTermMarking('n0');
    expect(fake.observedStatuses.filter((s) => s === 'STATUS: MARKING TERMS').length).toBeGreaterThan(0);
    const after = useNodeStatusStore.getState().statuses['n0'];
    expect(!after || after.clearedAt !== null).toBe(true);
  });
});
