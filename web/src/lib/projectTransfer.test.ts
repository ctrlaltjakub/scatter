import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildProjectZip, parseProjectZip, ProjectImportError,
  PROJECT_EXPORT_FORMAT, PROJECT_EXPORT_VERSION,
} from './projectTransfer';
import { saveAsset } from '@/opfs/assetsIO';
import type { Project, ScatterNode } from '@/store/types';
import { appendChatAnswer, createChatNode } from './chat/model';

/* OPFS mock, Blob-capable: unlike the string-only mocks in the other OPFS
 * tests, getFile() returns a real Blob so BOTH readJSON (`file.text()`) and
 * readBlob (asset bytes → `blob.arrayBuffer()`) work through it. */
class MockFile {
  data: string | Blob = '';
  async getFile() { return typeof this.data === 'string' ? new Blob([this.data]) : this.data; }
  async createWritable() {
    return { write: async (x: string | Blob) => { this.data = x; }, close: async () => {} };
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
  // listDir support, for symmetry with the projectActions mock.
  async *keys() { yield* [...this.files.keys(), ...this.dirs.keys()]; }
}

beforeEach(() => {
  const root = new MockDir();
  // @ts-expect-error mocking
  globalThis.navigator = { storage: { getDirectory: async () => root } };
});

function node(id: string): ScatterNode {
  return {
    id, type: 'manual-empty', position: { x: 10, y: 20 }, frozen: false,
    versions: [{ header: id, body: 'text', createdAt: 1, generatedBy: 'manual' }],
    currentVersionIndex: 0,
  };
}
function mediaNode(id: string, assetId: string): ScatterNode {
  return {
    id, type: 'media', position: { x: 0, y: 0 }, frozen: false,
    versions: [{
      header: 'pic', body: '', createdAt: 1, generatedBy: 'media',
      media: { source: 'asset', kind: 'image', assetId },
    }],
    currentVersionIndex: 0,
  };
}
function makeProject(id: string, name: string): Project {
  return {
    id, name, createdAt: 1, updatedAt: 2,
    rootNodeId: 'n1',
    nodes: { n1: node('n1') }, arrows: {}, groups: {},
    viewport: { x: 5, y: 6, zoom: 1.5 }, selection: [],
  };
}

/** Build a zip of arbitrary entries (for crafting malformed imports). */
async function zipOf(entries: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const blob = await zip.generateAsync({ type: 'blob' });
  return blob.arrayBuffer();
}

function envelopeJson(project: unknown, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: PROJECT_EXPORT_FORMAT,
    formatVersion: PROJECT_EXPORT_VERSION,
    exportedAt: 1,
    project,
    ...over,
  });
}

describe('projectTransfer — export', () => {
  it('keeps each version language when exporting and importing a project', async () => {
    const original = makeProject('languages', 'Languages');
    original.nodes.n1!.versions = ['en', 'ar', 'ja'].map((language, index) => ({
      header: 'Language', body: 'Saved text', language: language as 'en' | 'ar' | 'ja',
      createdAt: index + 1, generatedBy: 'manual',
    }));
    const { project } = await parseProjectZip(await (await buildProjectZip(original)).arrayBuffer());
    expect(project.nodes.n1!.versions.map(version => version.language)).toEqual(['en', 'ar', 'ja']);
  });
  it('round-trips chat attachment metadata and local image bytes', async () => {
    const project = makeProject('chat-export', 'Attached conversation');
    const chat = createChatNode({ id: 'n1', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    project.nodes.n1 = appendChatAnswer(chat, { turnId: 't', createdAt: 2, question: 'Read these', metadata: {
      attachments: [{ id: 'i', name: 'Photo.png', kind: 'image', media: { source: 'asset', kind: 'image', assetId: 'CHAT_IMAGE' } },
        { id: 'd', name: 'Notes.txt', kind: 'text', text: 'The attached notes.' }],
    } });
    await saveAsset(project.id, 'CHAT_IMAGE', new Blob([new Uint8Array([7, 8, 9])], { type: 'image/png' }));
    const imported = await parseProjectZip(await (await buildProjectZip(project)).arrayBuffer());
    expect([...imported.assets.keys()]).toContain('CHAT_IMAGE');
    expect(imported.project.nodes.n1?.versions[1]?.chat?.attachments).toEqual(project.nodes.n1.versions[1]?.chat?.attachments);
    expect(new Uint8Array(await imported.assets.get('CHAT_IMAGE')!.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
  });
  it('round-trips a project incl. media asset bytes', async () => {
    const p = makeProject('p1', 'Round trip');
    p.nodes['m1'] = mediaNode('m1', 'A1');
    await saveAsset('p1', 'A1', new Blob([new Uint8Array([9, 8, 7])]));

    const zipBlob = await buildProjectZip(p);
    const { project, assets } = await parseProjectZip(await zipBlob.arrayBuffer());

    expect(project).toEqual(p);
    expect([...assets.keys()]).toEqual(['A1']);
    expect(new Uint8Array(await assets.get('A1')!.arrayBuffer()))
      .toEqual(new Uint8Array([9, 8, 7]));
  });

  it('strips transient generation flags on export', async () => {
    const p = makeProject('p1', 'Transient');
    p.nodes['n1'] = { ...node('n1'), generating: true, generationError: 'boom' };
    const { project } = await parseProjectZip(await (await buildProjectZip(p)).arrayBuffer());
    expect(project.nodes['n1']).toBeDefined();
    expect('generating' in (project.nodes['n1'] as object)).toBe(false);
    expect('generationError' in (project.nodes['n1'] as object)).toBe(false);
  });

  it('skips referenced assets whose bytes are missing (no throw)', async () => {
    const p = makeProject('p1', 'Missing bytes');
    p.nodes['m1'] = mediaNode('m1', 'GONE');   // never saved via saveAsset
    const { assets } = await parseProjectZip(await (await buildProjectZip(p)).arrayBuffer());
    expect(assets.size).toBe(0);
  });
});

describe('projectTransfer — import validation', () => {
  it('rejects bytes that are not a zip', async () => {
    await expect(parseProjectZip(new Uint8Array([1, 2, 3, 4]).buffer))
      .rejects.toThrow(ProjectImportError);
  });

  it('rejects a zip without project.json', async () => {
    await expect(parseProjectZip(await zipOf({ 'readme.txt': 'hi' })))
      .rejects.toThrow(ProjectImportError);
  });

  it('rejects a project.json that is not JSON', async () => {
    await expect(parseProjectZip(await zipOf({ 'project.json': 'not json {' })))
      .rejects.toThrow(ProjectImportError);
  });

  it('rejects a wrong format marker', async () => {
    const bad = envelopeJson(makeProject('p', 'P'), { format: 'other-app' });
    await expect(parseProjectZip(await zipOf({ 'project.json': bad })))
      .rejects.toThrow(ProjectImportError);
  });

  it('rejects a NEWER formatVersion with a friendly message', async () => {
    const newer = envelopeJson(makeProject('p', 'P'), { formatVersion: PROJECT_EXPORT_VERSION + 1 });
    await expect(parseProjectZip(await zipOf({ 'project.json': newer })))
      .rejects.toThrow(/newer version/);
  });

  it('rejects a structurally-broken node', async () => {
    const p = makeProject('p', 'P');
    // @ts-expect-error breaking on purpose: versions missing
    p.nodes['bad'] = { id: 'bad', position: { x: 0, y: 0 }, currentVersionIndex: 0 };
    await expect(parseProjectZip(await zipOf({ 'project.json': envelopeJson(p) })))
      .rejects.toThrow(ProjectImportError);
  });

  it('defaults missing viewport / selection / name (older exports import fine)', async () => {
    const p = makeProject('p', 'P') as unknown as Record<string, unknown>;
    delete p.viewport;
    delete p.selection;
    delete p.name;
    const { project } = await parseProjectZip(await zipOf({ 'project.json': envelopeJson(p) }));
    expect(project.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(project.selection).toEqual([]);
    expect(project.name).toBe('Imported project');
  });

  it('keeps unknown extra project fields (forward compat within a version)', async () => {
    const p = { ...makeProject('p', 'P'), futureField: 'kept' };
    const { project } = await parseProjectZip(await zipOf({ 'project.json': envelopeJson(p) }));
    expect((project as unknown as Record<string, unknown>).futureField).toBe('kept');
  });

  it('ignores zip asset entries no node references', async () => {
    const { assets } = await parseProjectZip(await zipOf({
      'project.json': envelopeJson(makeProject('p', 'P')),
      'assets/GHOST': new Uint8Array([1]),
    }));
    expect(assets.size).toBe(0);
  });
});
