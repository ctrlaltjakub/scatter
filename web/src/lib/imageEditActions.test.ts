import { describe, it, expect, beforeEach } from 'vitest';
import { saveEditedImage, saveMediaHeaderVersion } from './imageEditActions';
import { useGraphStore } from '@/store/useGraphStore';
import { useMediaUrlStore } from '@/store/useMediaUrlStore';
import { loadAsset } from '@/opfs/assetsIO';
import { loadSettings, saveSettings } from '@/opfs/settingsIO';
import { DEFAULT_SETTINGS, type Project, type ScatterNode } from '@/store/types';

/* OPFS mock convention (see projectActions.test.ts): lazy Blob-capable file
 * handles + directory tree, wired into navigator.storage per test. */
class MockFile {
  data: string | Blob = '';
  async getFile() {
    const blob = () => (typeof this.data === 'string' ? new Blob([this.data]) : this.data);
    return {
      text: async () => blob().text(),
      arrayBuffer: async () => blob().arrayBuffer(),
    };
  }
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
  async *keys() { yield* [...this.files.keys(), ...this.dirs.keys()]; }
}

let urlCounter = 0;

beforeEach(() => {
  const root = new MockDir();
  // @ts-expect-error mocking
  globalThis.navigator = { storage: { getDirectory: async () => root } };
  // jsdom has no createObjectURL — the pipeline pre-registers display URLs with it.
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL =
    () => `blob:mock-${++urlCounter}`;
  useGraphStore.setState({
    project: null, projectList: [], activeProjectId: null,
    searchQuery: '', selectedGroupId: null,
  });
  useMediaUrlStore.setState({ urls: {} });
  useGraphStore.temporal.getState().clear();
});

function mediaNode(id: string): ScatterNode {
  return {
    id,
    type: 'media',
    position: { x: 0, y: 0 },
    frozen: false,
    currentVersionIndex: 0,
    versions: [
      {
        header: 'Sunset photo',
        body: '',
        createdAt: 1,
        generatedBy: 'media',
        contentType: 'media',
        width: 900,
        bodyMaxHeight: 600,
        media: {
          source: 'asset', kind: 'image', assetId: 'orig-asset', mime: 'image/jpeg',
          naturalWidth: 1200, naturalHeight: 800, byteSize: 1000, fileName: 'sunset.jpg',
        },
      },
    ],
  };
}

function seedProject(): Project {
  const project: Project = {
    id: 'proj-1', name: 'Test', createdAt: 1, updatedAt: 1,
    rootNodeId: 'n1',
    nodes: { n1: mediaNode('n1') },
    arrows: {}, groups: {},
    viewport: { x: 0, y: 0, zoom: 1 }, selection: [],
  };
  useGraphStore.setState({ project, activeProjectId: project.id });
  useGraphStore.temporal.getState().clear();
  return project;
}

const editedBlob = () =>
  new Blob([new Uint8Array([9, 8, 7, 6, 5])], { type: 'image/webp' });

it('never saves an in-flight editor image into a different project with the same node ID', async () => {
  const source = seedProject();
  const saving = saveEditedImage('n1', editedBlob(), { width: 600, height: 400 });
  const other = { ...source, id: 'other-project', nodes: { n1: mediaNode('n1') } };
  useGraphStore.setState({ project: other, activeProjectId: other.id });
  await expect(saving).rejects.toThrow(/project changed while saving/);
  expect(useGraphStore.getState().project?.nodes.n1?.versions).toHaveLength(1);
});

describe('saveEditedImage', () => {
  it('stores the baked bytes under a NEW asset id and appends a version referencing it', async () => {
    seedProject();
    await saveEditedImage('n1', editedBlob(), { width: 800, height: 400 });

    const node = useGraphStore.getState().project!.nodes.n1!;
    expect(node.versions).toHaveLength(2);
    expect(node.currentVersionIndex).toBe(1);

    const v = node.versions[1]!;
    expect(v.media?.assetId).toBeTruthy();
    expect(v.media?.assetId).not.toBe('orig-asset');

    const stored = await loadAsset('proj-1', v.media!.assetId!);
    expect(stored).not.toBeNull();
    expect(Array.from(new Uint8Array(await stored!.arrayBuffer()))).toEqual([9, 8, 7, 6, 5]);
  });

  it('fills the new version exactly: header/fileName carried, fresh media metadata', async () => {
    seedProject();
    await saveEditedImage('n1', editedBlob(), { width: 800, height: 400 });

    const v = useGraphStore.getState().project!.nodes.n1!.versions[1]!;
    expect(v.header).toBe('Sunset photo');
    expect(v.body).toBe('');
    expect(v.generatedBy).toBe('media');
    expect(v.contentType).toBe('media');
    expect(v.media).toMatchObject({
      source: 'asset',
      kind: 'image',
      mime: 'image/webp',
      naturalWidth: 800,
      naturalHeight: 400,
      byteSize: 5,
      fileName: 'sunset.jpg',
    });
  });

  it('preserves AI provenance when editing a generated image', async () => {
    const project = seedProject();
    const node = project.nodes.n1!;
    node.versions[0] = {
      ...node.versions[0]!,
      imageGeneration: {
        prompt: 'full original prompt', promptSource: 'media-prompt', providerId: 'p', model: 'm',
      },
    };
    useGraphStore.getState().setProject({ ...project, nodes: { ...project.nodes, n1: node } });

    await saveEditedImage('n1', editedBlob(), { width: 800, height: 400 });

    expect(useGraphStore.getState().project!.nodes.n1!.versions[1]?.imageGeneration).toMatchObject({
      prompt: 'full original prompt',
      providerId: 'p',
      model: 'm',
    });
  });

  it('keeps the user-chosen card width and re-derives the height for the new aspect', async () => {
    seedProject();
    await saveEditedImage('n1', editedBlob(), { width: 800, height: 400 });

    const v = useGraphStore.getState().project!.nodes.n1!.versions[1]!;
    expect(v.width).toBe(900);           // seeded card width survives the save
    expect(v.bodyMaxHeight).toBe(450);   // 900 × (400/800)
  });

  it('leaves the original version untouched', async () => {
    const before = JSON.stringify(seedProject().nodes.n1!.versions[0]);
    await saveEditedImage('n1', editedBlob(), { width: 800, height: 400 });
    const after = JSON.stringify(useGraphStore.getState().project!.nodes.n1!.versions[0]);
    expect(after).toBe(before);
  });

  it('registers a display URL for the new asset', async () => {
    seedProject();
    await saveEditedImage('n1', editedBlob(), { width: 800, height: 400 });
    const v = useGraphStore.getState().project!.nodes.n1!.versions[1]!;
    expect(useMediaUrlStore.getState().urls[v.media!.assetId!]).toMatch(/^blob:mock-/);
  });

  it('is exactly ONE app-level undo entry (undo restores the original state)', async () => {
    seedProject();
    await saveEditedImage('n1', editedBlob(), { width: 800, height: 400 });

    const temporal = useGraphStore.temporal.getState();
    expect(temporal.pastStates).toHaveLength(1);

    temporal.undo();
    const node = useGraphStore.getState().project!.nodes.n1!;
    expect(node.versions).toHaveLength(1);
    expect(node.currentVersionIndex).toBe(0);
  });

  it('no-ops when the node is missing', async () => {
    seedProject();
    await saveEditedImage('ghost', editedBlob(), { width: 800, height: 400 });
    expect(useGraphStore.getState().project!.nodes.n1!.versions).toHaveLength(1);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('saves a header-only edit as one version while retaining the exact image and provenance', () => {
    const project = seedProject();
    const original = project.nodes.n1!.versions[0]!;
    original.imageGeneration = {
      prompt: 'the provider prompt', promptSource: 'media-prompt', providerId: 'p', model: 'm',
    };
    useGraphStore.getState().setProject({ ...project });

    saveMediaHeaderVersion('n1', {
      prefix: 'Diagram', subject: 'Cell membrane', question: 'How does it work?', suffix: 'annotated',
    });

    const node = useGraphStore.getState().project!.nodes.n1!;
    expect(node.versions).toHaveLength(2);
    expect(node.versions[1]).toMatchObject({
      header: 'Diagram: Cell membrane: How does it work? - annotated',
      headerParts: {
        prefix: 'Diagram', subject: 'Cell membrane', question: 'How does it work?', suffix: 'annotated',
      },
      generatedBy: 'manual',
      media: original.media,
      imageGeneration: original.imageGeneration,
    });
  });
});

describe('imageModelRef persistence', () => {
  it('survives a settings save → load round-trip', async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      imageModelRef: { providerId: 'prov-1', model: 'pixel-painter-1' },
    });
    const loaded = await loadSettings();
    expect(loaded.imageModelRef).toEqual({ providerId: 'prov-1', model: 'pixel-painter-1' });
  });

  it('drops a malformed stored ref instead of crashing', async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      imageModelRef: { providerId: '', model: 42 } as never,
    });
    const loaded = await loadSettings();
    expect(loaded.imageModelRef).toBeUndefined();
  });
});
