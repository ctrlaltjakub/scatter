import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { regenerateNode, retryGeneration, spawnExplain, spawnTermClick } from './generate';

// This suite counts answer/structure/marking calls; background previews have
// their own provider lifecycle coverage in termPreviews.test.ts.
vi.mock('./termPreviews', () => ({ generateTermPreviews: vi.fn(async () => {}) }));

const BODY = `A compact opening paragraph.

- Alpha
  - one: First detail
  - two: Second detail
- Beta
  - one: Third detail
  - two: Fourth detail`;

const fake = vi.hoisted(() => ({
  used: false,
  requests: 0,
  suggestions: undefined as string[] | undefined,
  error: undefined as string | undefined,
  body: '',
  citations: [] as Array<{ url: string; title?: string; startIndex?: number; endIndex?: number; offsetKind?: 'claim' | 'citation-label' }>,
  finishReason: undefined as string | null | undefined,
  calls: 0,
  messages: [] as string[][],
}));

vi.mock('@/providers/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/providers/registry')>();
  return {
    ...orig,
    getAdapter: () => ({
      listModels: async () => [],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamChat(_key: string, opts: { webSearch?: boolean; messages: { content: string }[] }) {
        fake.calls += 1;
        fake.messages.push(opts.messages.map((message) => message.content));
        if (opts.messages[0]?.content.includes('REQUIRED RESPONSE FORMAT')) {
          yield { delta: '{"terms":[]}', done: true };
          return;
        }
        if (opts.webSearch === false) {
          yield { delta: BODY, done: false };
          yield { delta: '', done: true };
          return;
        }
        yield { delta: fake.body, done: false };
        yield {
          delta: '', done: true,
          citations: fake.citations,
          finishReason: fake.finishReason,
          webSearch: { used: fake.used, requestCount: fake.requests, error: fake.error },
          googleSearchSuggestions: fake.suggestions,
        };
      },
      capabilities: { webSearch: true },
    }),
  };
});

function seed(): void {
  const parent: ScatterNode = {
    id: 'parent', type: 'root', position: { x: 0, y: 0 }, frozen: true,
    versions: [{ header: 'Parent', body: BODY, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('search-status', parent.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [parent.id]: parent } });
  useGraphStore.getState().setActiveProjectId(project.id);
}

beforeEach(() => {
  fake.used = false;
  fake.requests = 0;
  fake.suggestions = undefined;
  fake.error = undefined;
  fake.body = BODY;
  fake.citations = [];
  fake.finishReason = undefined;
  fake.calls = 0;
  fake.messages = [];
  useSettingsStore.setState({
    providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'sk-test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p1', model: 'm' },
    webSearch: true,
  });
  seed();
});

afterEach(() => {
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().setActiveProjectId(null);
});

describe('generation web-search provenance', () => {
  it('adds strong grounding guidance to a normal node user request', async () => {
    await spawnTermClick('parent', 'current research');
    expect(fake.messages[0]?.at(-1)).toMatch(/ground this response in web search before writing/i);
    expect(fake.messages[0]?.at(-1)).toMatch(/wikipedia as a grounding source when relevant/i);
    expect(fake.messages[0]?.at(-1)).toMatch(/do not invent bare bracketed source names/i);
  });

  it('adds the same search guidance to explanation requests', async () => {
    await spawnExplain('parent', 'current research');
    expect(fake.messages[0]?.at(-1)).toMatch(/ground this response in web search before writing/i);
  });

  it('marks a version web-searched only from confirmed provider activity', async () => {
    fake.used = true;
    fake.requests = 2;
    fake.suggestions = ['<div>Google Search</div>'];
    const id = await spawnTermClick('parent', 'fresh topic');
    const version = useGraphStore.getState().project!.nodes[id]!.versions[0]!;
    expect(version.webSearched).toBe(true);
    expect(version.webSearchFailed).toBeUndefined();
    expect(version.googleSearchSuggestions).toEqual(fake.suggestions);
  });

  it('keeps Google search rows scoped to each regenerated version', async () => {
    fake.used = true;
    fake.requests = 1;
    fake.suggestions = ['<div>First search</div>'];
    fake.citations = [{ url: 'https://first.example/source', startIndex: 0, endIndex: 28 }];
    const id = await spawnTermClick('parent', 'fresh topic');
    fake.suggestions = ['<div>Second search</div>'];
    fake.citations = [{ url: 'https://second.example/source', startIndex: 0, endIndex: 28 }];
    await regenerateNode(id);
    const node = useGraphStore.getState().project!.nodes[id]!;
    expect(node.versions).toHaveLength(2);
    expect(node.versions[0]!.googleSearchSuggestions).toEqual(['<div>First search</div>']);
    expect(node.versions[1]!.googleSearchSuggestions).toEqual(['<div>Second search</div>']);
    expect(node.versions[1]!.sources?.map(source => source.url)).toEqual(['https://second.example/source']);
  });

  it('does not copy an older search row when regenerating with search off', async () => {
    fake.used = true;
    fake.requests = 1;
    fake.suggestions = ['<div>First search</div>'];
    fake.citations = [{ url: 'https://first.example/source', startIndex: 0, endIndex: 28 }];
    const id = await spawnTermClick('parent', 'fresh topic');
    useSettingsStore.setState({ webSearch: false });
    await regenerateNode(id);
    const node = useGraphStore.getState().project!.nodes[id]!;
    expect(node.versions[0]!.googleSearchSuggestions).toEqual(['<div>First search</div>']);
    expect(node.versions[1]!.googleSearchSuggestions).toBeUndefined();
  });

  it('keeps a usable answer but labels it when requested search was not confirmed', async () => {
    fake.error = 'unavailable';
    const id = await spawnTermClick('parent', 'fresh topic');
    const version = useGraphStore.getState().project!.nodes[id]!.versions[0]!;
    expect(version.webSearched).toBeUndefined();
    expect(version.webSearchFailed).toBe(true);
  });

  it('removes unbacked model-written citation labels before term marking', async () => {
    fake.body = BODY.replace('paragraph.', 'paragraph [1].');
    await spawnTermClick('parent', 'fresh topic');
    expect(fake.messages[1]?.join('\n')).not.toContain('[1]');
    expect(fake.messages[1]?.join('\n')).toContain('A compact opening paragraph.');
  });

  it('clears stale search provenance when retrying with search switched off', async () => {
    fake.used = true;
    fake.requests = 1;
    fake.suggestions = ['<div>Google Search</div>'];
    const id = await spawnTermClick('parent', 'fresh topic');
    expect(useGraphStore.getState().project!.nodes[id]!.versions[0]!.webSearched).toBe(true);

    useSettingsStore.setState({ webSearch: false });
    fake.messages = [];
    await retryGeneration(id);
    const version = useGraphStore.getState().project!.nodes[id]!.versions[0]!;
    expect(version.webSearched).toBeUndefined();
    expect(version.webSearchFailed).toBeUndefined();
    expect(version.sources).toBeUndefined();
    expect(version.googleSearchSuggestions).toBeUndefined();
    expect(fake.messages[0]?.at(-1)).not.toMatch(/ground this response in web search/i);
  });

  it('does not report failure when the active provider does not support hosted search', async () => {
    useSettingsStore.setState({
      providers: [{ id: 'p1', preset: 'custom', apiKey: 'local', baseUrl: 'http://localhost/v1', enabledModels: ['m'] }],
      activeModelRef: { providerId: 'p1', model: 'm' },
      webSearch: true,
    });
    const id = await spawnTermClick('parent', 'local topic');
    const version = useGraphStore.getState().project!.nodes[id]!.versions[0]!;
    expect(version.webSearched).toBeUndefined();
    expect(version.webSearchFailed).toBeUndefined();
    expect(fake.messages[0]?.at(-1)).not.toMatch(/ground this response in web search/i);
  });

  it('stops an empty first response before starting structure repair', async () => {
    fake.body = '';
    const id = await spawnTermClick('parent', 'empty topic');
    const node = useGraphStore.getState().project!.nodes[id]!;
    expect(fake.calls).toBe(1);
    expect(node.generationError).toMatch(/returned no text/i);
  });

  it('rejects leaked raw web-search tool syntax instead of rendering it', async () => {
    fake.body = '<tool_call>openrouter_web_search(query="latest research")';
    const id = await spawnTermClick('parent', 'leaked tool topic');
    const node = useGraphStore.getState().project!.nodes[id]!;
    expect(fake.calls).toBe(1);
    expect(node.generationError).toMatch(/web search tool call/i);
  });

  it('rejects a native Gemini answer cut off inside a grounding URL even when it reports stop', async () => {
    const full = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABCDEFGHIJK';
    fake.body = `Pacific basin [source](${full.slice(0, -5)}`;
    fake.citations = [{ url: full, title: 'example.org', offsetKind: 'citation-label' }];
    fake.finishReason = 'stop';
    const paintedBodies: string[] = [];
    const unsubscribe = useGraphStore.subscribe((state) => {
      for (const [nodeId, node] of Object.entries(state.project?.nodes ?? {})) {
        if (nodeId !== 'parent') paintedBodies.push(node.versions[node.currentVersionIndex]?.body ?? '');
      }
    });
    const id = await spawnTermClick('parent', 'El Niño in Europe');
    unsubscribe();
    const node = useGraphStore.getState().project!.nodes[id]!;
    expect(fake.calls).toBe(1);
    expect(node.generationError).toMatch(/inside a source link/i);
    expect(node.versions[0]!.body).toBe('');
    expect(node.versions[0]!.body).not.toContain('vertexaisearch');
    expect(paintedBodies.every((body) => !body.includes('http') && !body.includes('vertexaisearch'))).toBe(true);
  });

  it('recovers a complete inline source link when the gateway omits annotations', async () => {
    const url = 'https://example.org/research';
    fake.body = BODY.replace('paragraph.', `paragraph [research](${url}).`);
    fake.used = true;
    const id = await spawnTermClick('parent', 'fresh topic');
    const version = useGraphStore.getState().project!.nodes[id]!.versions[0]!;
    expect(version.body).toContain('paragraph⟦1⟧.');
    expect(version.body).not.toContain('](');
    expect(version.sources?.map((source) => source.url)).toEqual([url]);
  });

  it('normalizes the bracketed absolute URLs returned by the live Exa-backed Gemini stream', async () => {
    const url = 'https://repository.library.noaa.gov/view/noaa/21547';
    fake.body = BODY.replace('paragraph.', `paragraph [${url}].`);
    fake.citations = [{ url, title: 'NOAA repository', offsetKind: 'citation-label' }];
    fake.used = true;
    fake.requests = 1;
    fake.finishReason = 'stop';
    const id = await spawnTermClick('parent', 'El Niño in Europe');
    const version = useGraphStore.getState().project!.nodes[id]!.versions[0]!;
    expect(version.body).toContain('paragraph⟦1⟧.');
    expect(version.body).not.toContain('https://');
    expect(version.sources?.map((source) => source.url)).toEqual([url]);
  });

  it('repairs a complete searched answer that omitted the required bullets without dropping its source', async () => {
    const url = 'https://example.org/evidence';
    fake.body = `A complete opening paragraph [${url}].`;
    fake.citations = [{ url, title: 'Evidence', offsetKind: 'citation-label' }];
    fake.used = true;
    fake.requests = 1;
    fake.finishReason = 'stop';
    const id = await spawnTermClick('parent', 'structured topic');
    const version = useGraphStore.getState().project!.nodes[id]!.versions[0]!;
    expect(fake.calls).toBe(3); // answer, structure repair, term marking
    expect(version.body).toContain('- Alpha');
    expect(version.body).toContain('⟦1⟧');
    expect(version.body).not.toContain('https://');
    expect(version.sources?.map((source) => source.url)).toEqual([url]);
  });
});
