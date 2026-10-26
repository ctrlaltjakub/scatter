import { describe, it, expect, beforeEach } from 'vitest';
import { loadProject, saveProject, stripTransient } from './projectIO';
import type { Project } from '@/store/types';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';

class MockFile { contents = ''; async getFile() { return { text: async () => this.contents }; }
  async createWritable() { return { write: async (s: string) => { this.contents = s; }, close: async () => {} }; } }
class MockDir {
  files = new Map<string, MockFile>(); dirs = new Map<string, MockDir>();
  async getFileHandle(n: string, o?: { create?: boolean }) {
    if (!this.files.has(n)) { if (!o?.create) throw new DOMException('NotFound','NotFoundError'); this.files.set(n, new MockFile()); }
    return this.files.get(n)!;
  }
  async getDirectoryHandle(n: string, o?: { create?: boolean }) {
    if (!this.dirs.has(n)) { if (!o?.create) throw new DOMException('NotFound','NotFoundError'); this.dirs.set(n, new MockDir()); }
    return this.dirs.get(n)!;
  }
}

beforeEach(() => {
  const root = new MockDir();
  // @ts-expect-error mocking
  globalThis.navigator = { storage: { getDirectory: async () => root } };
});

const sample: Project = {
  id: 'p1', name: 'Test', createdAt: 1, updatedAt: 1,
  rootNodeId: 'n1',
  nodes: {}, arrows: {}, groups: {},
  viewport: { x: 0, y: 0, zoom: 1 }, selection: [],
};

describe('projectIO', () => {
  it('recovers an interrupted group title without changing the live task or losing group membership', async () => {
    const group = { id: 'g', name: 'Generating title', color: '#aaa', gravitate: false,
      titleGeneration: { id: 'request', headers: ['Working memory', 'Practice'] } };
    const project = { ...sample, groups: { g: group } };
    await saveProject(project);
    expect((await loadProject())?.groups.g).toMatchObject({ name: 'Untitled group', titleGeneration: { error: 'Title generation was interrupted.' } });
    expect(project.groups.g.name).toBe('Generating title');
    expect(project.groups.g.titleGeneration).not.toHaveProperty('error');
  });
  it('round-trips saved term explanations with their text version', async () => {
    const termPreviews = { fingerprint: 'body-signature', entries: { cache: 'A **temporary store** enables **faster access** to data.' } };
    const project: Project = { ...sample, nodes: { n1: { id: 'n1', type: 'root', frozen: false,
      position: { x: 0, y: 0 }, currentVersionIndex: 0,
      versions: [{ header: 'Memory', body: 'A [[cache]].', createdAt: 1, generatedBy: 'root', termPreviews }] } } };
    await saveProject(project);
    expect((await loadProject())?.nodes.n1?.versions[0]?.termPreviews).toEqual(termPreviews);
  });
  it('round-trips chat enrichment and interruptions without mutating a live generation', async () => {
    let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 5, y: 6 }, bodyHeight: 650 });
    node = appendChatAnswer(node, { turnId: 'turn', createdAt: 2, question: 'Question' });
    node = updateChatAnswer(node, { turnId: 'turn', versionCreatedAt: 2 }, { body: '**Partial** [[answer]]',
      sources: [{ n: 1, url: 'https://example.com/evidence' }] }, { title: 'Memory',
      tools: [{ id: 'call', name: 'search_conversation', summary: 'Searching', state: 'running' }] });
    const project = { ...sample, rootNodeId: node.id, nodes: { [node.id]: node } };
    await saveProject(project);
    const loaded = await loadProject();
    expect(loaded?.nodes.chat?.versions[1]).toMatchObject({ body: '**Partial** [[answer]]', bodyMaxHeight: 650,
      chat: { title: 'Memory', state: 'interrupted', tools: [{ state: 'stopped' }] },
      sources: [{ n: 1, url: 'https://example.com/evidence' }] });
    expect(loaded?.nodes.chat?.chat?.turns[0]?.selectedVersionCreatedAt).toBe(2);
    expect(loaded?.nodes.chat).not.toHaveProperty('generating');
    expect(node.versions[1]?.chat?.state).toBe('generating');
    expect(node.generating).toBe(true);
  });
  it('does not clone clean projects during loading', () => {
    expect(stripTransient(sample)).toBe(sample);
  });

  it('removes transient fields even when their values are false or empty', () => {
    const project: Project = {
      ...sample,
      nodes: {
        n1: {
          id: 'n1',
          type: 'term-click',
          frozen: false,
          position: { x: 0, y: 0 },
          versions: [],
          currentVersionIndex: 0,
          generating: false,
          generatingVersionIndex: 0,
          streamingText: false,
          generationError: '',
        },
      },
    };

    const clean = stripTransient(project);
    expect(clean).not.toBe(project);
    expect(clean.nodes.n1).toEqual({
      id: 'n1',
      type: 'term-click',
      frozen: false,
      position: { x: 0, y: 0 },
      versions: [],
      currentVersionIndex: 0,
    });
  });

  it('loadProject returns null when no project saved', async () => {
    expect(await loadProject()).toBeNull();
  });
  it('saveProject then loadProject returns the same data', async () => {
    await saveProject(sample);
    expect(await loadProject()).toEqual(sample);
  });
});
