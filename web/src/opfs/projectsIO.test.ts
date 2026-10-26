import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadProjectsIndex, saveProjectsIndex,
  loadProjectById, saveProjectFile, deleteProjectFile, metaOf,
  patchProjectFile, flushProjectFileMirror,
} from './projectsIO';
import type { Project, ProjectsIndex } from '@/store/types';
import type { ProjectFilePatch } from './projectPersistenceProtocol';
import { applyProjectFilePatch } from './projectPersistenceApply';

class MockFile {
  contents = '';
  async getFile() { return { text: async () => this.contents }; }
  async createWritable() {
    return { write: async (s: string) => { this.contents = s; }, close: async () => {} };
  }
}
class MockDir {
  files = new Map<string, MockFile>();
  dirs = new Map<string, MockDir>();
  async getFileHandle(n: string, o?: { create?: boolean }) {
    if (!this.files.has(n)) { if (!o?.create) throw new DOMException('NotFound', 'NotFoundError'); this.files.set(n, new MockFile()); }
    return this.files.get(n)!;
  }
  async getDirectoryHandle(n: string, o?: { create?: boolean }) {
    if (!this.dirs.has(n)) { if (!o?.create) throw new DOMException('NotFound', 'NotFoundError'); this.dirs.set(n, new MockDir()); }
    return this.dirs.get(n)!;
  }
  async removeEntry(n: string) {
    if (!this.files.delete(n) && !this.dirs.delete(n)) {
      throw new DOMException('NotFound', 'NotFoundError');
    }
  }
}

beforeEach(() => {
  const root = new MockDir();
  // @ts-expect-error mocking
  globalThis.navigator = { storage: { getDirectory: async () => root } };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeProject(id: string, name: string): Project {
  return {
    id, name, createdAt: 1, updatedAt: 2,
    rootNodeId: 'n1',
    nodes: {}, arrows: {}, groups: {},
    viewport: { x: 0, y: 0, zoom: 1 }, selection: [],
  };
}

describe('projectsIO', () => {
  it('loadProjectsIndex returns null when nothing saved', async () => {
    expect(await loadProjectsIndex()).toBeNull();
  });

  it('saves and reloads the registry index', async () => {
    const idx: ProjectsIndex = {
      activeId: 'a',
      items: [
        { id: 'a', name: 'Alpha', createdAt: 1, updatedAt: 9 },
        { id: 'b', name: 'Beta', createdAt: 2, updatedAt: 5 },
      ],
    };
    await saveProjectsIndex(idx);
    expect(await loadProjectsIndex()).toEqual(idx);
  });

  it('saves and loads a project by id (separate files per scatter)', async () => {
    const a = makeProject('a', 'Alpha');
    const b = makeProject('b', 'Beta');
    await saveProjectFile(a);
    await saveProjectFile(b);
    expect(await loadProjectById('a')).toEqual(a);
    expect(await loadProjectById('b')).toEqual(b);
  });

  it('loadProjectById returns null for an unknown id', async () => {
    expect(await loadProjectById('missing')).toBeNull();
  });

  it('deleteProjectFile removes only that scatter', async () => {
    await saveProjectFile(makeProject('a', 'Alpha'));
    await saveProjectFile(makeProject('b', 'Beta'));
    await deleteProjectFile('a');
    expect(await loadProjectById('a')).toBeNull();
    expect(await loadProjectById('b')).not.toBeNull();
  });

  it('deleteProjectFile on a missing scatter is a no-op (no throw)', async () => {
    await expect(deleteProjectFile('nope')).resolves.toBeUndefined();
  });

  it('strips transient per-node fields on save (matches projectIO behavior)', async () => {
    const p = makeProject('a', 'Alpha');
    // @ts-expect-error injecting a transient field the type forbids
    p.nodes['n1'] = { id: 'n1', generating: true, versions: [], currentVersionIndex: 0, position: { x: 0, y: 0 } };
    await saveProjectFile(p);
    const loaded = await loadProjectById('a');
    expect(loaded?.nodes['n1']).toBeDefined();
    expect('generating' in (loaded!.nodes['n1'] as object)).toBe(false);
  });

  it('serializes and parses full project files in a worker', async () => {
    const messages: Array<{
      id: number;
      type: string;
      path?: string;
      data?: unknown;
      patch?: ProjectFilePatch;
    }> = [];
    const files = new Map<string, unknown>();
    const mirrors = new Map<string, Project>();

    class ProjectFileWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      streams = new Map<number, Array<Record<string, unknown>>>();

      postMessage(message: {
        id: number;
        type: string;
        path?: string;
        data?: unknown;
        patch?: ProjectFilePatch;
      }) {
        messages.push(message);
        queueMicrotask(() => {
          if (message.type === 'continue-read') {
            const queue = this.streams.get(message.id);
            const next = queue?.shift();
            if (next) this.onmessage?.(new MessageEvent('message', { data: next }));
            if (queue?.length === 0) this.streams.delete(message.id);
            return;
          }
          if (message.type === 'write') {
            files.set(message.path!, message.data);
            mirrors.set(message.path!, message.data as Project);
            this.onmessage?.(new MessageEvent('message', {
              data: { id: message.id, ok: true, value: null },
            }));
          } else if (message.type === 'patch') {
            mirrors.set(
              message.path!,
              applyProjectFilePatch(mirrors.get(message.path!)!, message.patch!),
            );
            this.onmessage?.(new MessageEvent('message', {
              data: { id: message.id, ok: true, value: null },
            }));
          } else if (message.type === 'flush') {
            files.set(message.path!, mirrors.get(message.path!));
            this.onmessage?.(new MessageEvent('message', {
              data: { id: message.id, ok: true, value: null },
            }));
          } else {
            const value = files.get(message.path!) ?? null;
            if (value) mirrors.set(message.path!, value as Project);
            const nodes = value && typeof value === 'object'
              ? Object.entries((value as Project).nodes ?? {})
              : [];
            if (nodes.length > 32) {
              const { nodes: _nodes, ...base } = value as Project;
              const queue: Array<Record<string, unknown>> = [];
              for (let start = 0; start < nodes.length; start += 32) {
                queue.push({
                  id: message.id,
                  ok: true,
                  phase: 'nodes',
                  value: nodes.slice(start, start + 32),
                });
              }
              queue.push({ id: message.id, ok: true, phase: 'complete' });
              this.streams.set(message.id, queue);
              this.onmessage?.(new MessageEvent('message', {
                data: { id: message.id, ok: true, phase: 'start', value: base },
              }));
              return;
            }
            this.onmessage?.(new MessageEvent('message', {
              data: { id: message.id, ok: true, value },
            }));
          }
        });
      }
    }

    vi.stubGlobal('Worker', ProjectFileWorker);
    const project = makeProject('worker-project', 'Large project');

    await saveProjectFile(project);
    expect(await loadProjectById(project.id)).toEqual(project);

    const patch: ProjectFilePatch = {
      revision: 1,
      base: { set: { name: 'Patched' }, remove: [] },
      nodes: { upsert: {}, update: {}, remove: [] },
      arrows: { upsert: {}, remove: [] },
      groups: { upsert: {}, remove: [] },
      runtime: { positions: {}, anchors: {}, activeBulletIdx: {} },
    };
    expect(await patchProjectFile(project.id, patch)).toBe(true);
    expect(await flushProjectFileMirror(project.id, 1)).toBe(true);
    expect((await loadProjectById(project.id))?.name).toBe('Patched');

    const large = makeProject('streamed-project', 'Streamed project');
    for (let index = 0; index < 70; index += 1) {
      const id = `n${index}`;
      large.nodes[id] = {
        id,
        type: 'term-click',
        frozen: false,
        versions: [],
        currentVersionIndex: 0,
        position: { x: index, y: index },
      };
    }
    await saveProjectFile(large);
    expect(await loadProjectById(large.id)).toEqual(large);

    expect(messages.slice(0, 2).map((message) => message.type)).toEqual(['write', 'read']);
    expect(messages.map((message) => message.type)).toContain('patch');
    expect(messages.map((message) => message.type)).toContain('flush');
    expect(messages.filter((message) => message.type === 'continue-read')).toHaveLength(4);
    expect(messages.filter((message) => message.path).every((message) =>
      message.path === 'projects/worker-project.json'
      || message.path === 'projects/streamed-project.json')).toBe(true);
  });

  it('metaOf extracts the registry row', () => {
    expect(metaOf(makeProject('a', 'Alpha'))).toEqual({
      id: 'a', name: 'Alpha', createdAt: 1, updatedAt: 2,
    });
  });
});
