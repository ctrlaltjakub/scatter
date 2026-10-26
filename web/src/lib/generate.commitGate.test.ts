/**
 * Pass-1 streaming commits at bullet boundaries (integration).
 *
 * Through the real spawn path (spawnTermClick → streamIntoVersion →
 * streamChunks with a commit gate): the intro streams live, but once bullets
 * start, the store sees only whole-bullet commits — never a body that ends
 * mid-bullet — and the final body (after the chip pass) is the full text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { saveManualEdit, spawnTermClick } from './generate';

const INTRO = 'Alpha is a synthetic concept used to exercise the streaming commit gate.';
const PLAIN =
  `${INTRO}\n\n` +
  '- **First area**\n  - one: detail sentence here\n  - two: another detail sentence\n' +
  '- **Second area**\n  - three: more detail text\n  - four: still more detail\n' +
  '- **Third area**\n  - five: detail again\n  - six: final detail line';
const CHIPPED = PLAIN.replace(/\bdetail\b/g, '[[detail]]');

/* Adapter scripts: call 1 = pass 1 (plain, chunked mid-word), call 2 = chip
 * pass (one delta). Between pass-1 yields we record the child's CURRENT body
 * as the store sees it. */
const fake = vi.hoisted(() => ({
  calls: 0,
  includeCitation: false,
  sourcesAtChipStart: 0,
  observedBodies: [] as string[],
  observedStreamingText: [] as boolean[],
  pauseFirstPass: false,
  firstPassPaused: false,
  releaseFirstPass: null as null | (() => void),
  delayMs: 115,
  reset() {
    this.calls = 0;
    this.includeCitation = false;
    this.sourcesAtChipStart = 0;
    this.observedBodies = [];
    this.observedStreamingText = [];
    this.pauseFirstPass = false;
    this.firstPassPaused = false;
    this.releaseFirstPass = null;
    this.delayMs = 115;
  },
}));

function childNode() {
  const proj = useGraphStore.getState().project;
  if (!proj) return undefined;
  return Object.values(proj.nodes).find((n) => n.id !== 'n0');
}

function childBody(): string {
  const child = childNode();
  if (!child) return '';
  return child.versions[child.currentVersionIndex]?.body ?? '';
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

vi.mock('@/providers/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...orig,
    getAdapter: () => ({
      listModels: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamChat() {
        fake.calls++;
        if (fake.calls === 1) {
          for (const [index, delta] of chunk(PLAIN, 17).entries()) {
            yield { delta, done: false };
            await new Promise((r) => setTimeout(r, fake.delayMs)); // let the coalescer deliver
            fake.observedBodies.push(childBody());
            fake.observedStreamingText.push(!!childNode()?.streamingText);
            if (fake.pauseFirstPass && index === 1) {
              fake.firstPassPaused = true;
              await new Promise<void>((resolve) => { fake.releaseFirstPass = resolve; });
            }
          }
          if (fake.includeCitation) {
            yield {
              delta: '', done: true,
              citations: [{ url: 'https://example.com/source', title: 'Example', startIndex: 0, endIndex: PLAIN.length }],
            };
            return;
          }
        } else {
          fake.sourcesAtChipStart = childNode()?.versions[childNode()!.currentVersionIndex]?.sources?.length ?? 0;
          yield { delta: '{"terms":["detail"]}', done: false };
        }
        yield { delta: '', done: true };
      },
      capabilities: {},
    }),
  };
});

function seed(): void {
  const node: ScatterNode = {
    id: 'n0',
    type: 'root',
    position: { x: 0, y: 0 },
    frozen: false,
    renderedHeight: 300,
    versions: [{
      header: 'Parent', body: 'Parent body mentioning [[Alpha]].', createdAt: 0,
      generatedBy: 'root', width: 624, bodyMaxHeight: 228,
    }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('commit-gate', 'n0');
  useGraphStore.getState().setProject({ ...project, nodes: { n0: node } });
  useGraphStore.getState().setActiveProjectId(project.id);
  useGraphStore.temporal.getState().clear();
}

beforeEach(() => {
  fake.reset();
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'sk-test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    webSearch: false,
  });
  seed();
});

afterEach(() => {
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('pass-1 bullet-boundary commits (spawn path)', () => {
  it('the store never sees a body that ends mid-bullet, and the final body is complete', async () => {
    await spawnTermClick('n0', 'Alpha');

    const seen = fake.observedBodies.filter((b) => b !== '');
    expect(seen.length).toBeGreaterThan(3);

    for (const b of seen) {
      // Intro-phase commits contain no bullet yet; list-phase commits are
      // whole-bullet prefixes ending at a line boundary. A body that contains
      // a bullet but ends mid-line means a partial bullet reached the store.
      const inListPhase = /\n[-*+]\s/.test(b);
      if (inListPhase && b !== PLAIN) {
        expect(b.endsWith('\n'), `mid-bullet body reached the store: …${JSON.stringify(b.slice(-40))}`).toBe(true);
      }
    }

    // Far fewer store-visible states than deltas (intro live + one per bullet
    // + final), and the completed node carries the full chipped body.
    const distinct = new Set(seen);
    expect(distinct.size).toBeLessThan(chunk(PLAIN, 17).length - 5);
    expect(childBody()).toBe(CHIPPED);
  });

  it('flags streamingText for pass 1 only and clears it when the spawn completes', async () => {
    await spawnTermClick('n0', 'Alpha');
    // The tail skeleton's flag was up for the whole text stream…
    expect(fake.observedStreamingText.length).toBeGreaterThan(3);
    expect(fake.observedStreamingText.every(Boolean)).toBe(true);
    // …and is fully cleared (with `generating`) once the spawn is done.
    expect(childNode()?.streamingText).toBeFalsy();
    expect(childNode()?.generating).toBeFalsy();
  });

  it('attaches pass-1 sources before the chip pass starts, then keeps them renumbered', async () => {
    fake.includeCitation = true;
    await spawnTermClick('n0', 'Alpha');
    expect(fake.sourcesAtChipStart).toBe(1);
    const child = childNode()!;
    const version = child.versions[child.currentVersionIndex]!;
    expect(version.sources).toEqual([expect.objectContaining({ n: 1, url: 'https://example.com/source' })]);
    expect(version.body).toContain('⟦1⟧');
  });

  it('keeps an initial stream on its original version when a manual header version is appended', async () => {
    fake.pauseFirstPass = true;
    fake.delayMs = 40;
    const generation = spawnTermClick('n0', 'Alpha');
    await vi.waitFor(() => expect(fake.firstPassPaused).toBe(true));

    const child = childNode()!;
    const partialBody = child.versions[0]!.body;
    expect(partialBody).not.toBe('');
    saveManualEdit(child.id, 'Manual title', partialBody);
    fake.delayMs = 0;
    fake.releaseFirstPass?.();
    await generation;

    const finished = childNode()!;
    expect(finished.versions).toHaveLength(2);
    expect(finished.versions[0]!.body).toBe(CHIPPED);
    expect(finished.versions[1]).toEqual(expect.objectContaining({
      header: 'Manual title',
      body: partialBody,
      generatedBy: 'manual',
    }));
  });
});
