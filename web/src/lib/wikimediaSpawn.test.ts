import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { ScatterNode, WikimediaImageRecommendation } from '@/store/types';
import { spawnWikimediaImageNode } from './wikimediaSpawn';

const saveAsset = vi.fn();
vi.mock('@/opfs/assetsIO', () => ({ saveAsset: (...args: unknown[]) => saveAsset(...args) }));

const result: WikimediaImageRecommendation = {
  pageId: 7,
  fileTitle: 'File:Neuron.jpg',
  filePageUrl: 'https://commons.wikimedia.org/wiki/File:Neuron.jpg',
  thumbnailUrl: 'https://upload.wikimedia.org/neuron-1600.jpg',
  originalUrl: 'https://upload.wikimedia.org/neuron.jpg',
  caption: 'Neuron structure',
  creator: 'Researcher',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  creditLine: 'Researcher / Wikimedia Commons',
};

beforeEach(() => {
  saveAsset.mockReset().mockResolvedValue(undefined);
  const downloaded = new Blob(['image'], { type: 'image/jpeg' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => downloaded }));
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1200, height: 800, close: vi.fn() }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:commons');
  const parent: ScatterNode = {
    id: 'parent', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    groupId: 'g1',
    versions: [{ header: 'Neurons', body: 'Body', createdAt: 1, generatedBy: 'term-click' }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('wikimedia', parent.id);
  useGraphStore.getState().setProject({
    ...project,
    nodes: { parent },
    groups: { g1: { id: 'g1', name: 'Biology', color: 'green', gravitate: true } },
    selection: ['parent'],
  });
  useGraphStore.temporal.getState().clear();
});

describe('spawnWikimediaImageNode', () => {
  it('stores a local attributed image and adds an undoable grouped child', async () => {
    const nodeId = await spawnWikimediaImageNode('parent', result);
    const project = useGraphStore.getState().project!;
    const node = project.nodes[nodeId]!;
    expect(node.groupId).toBe('g1');
    expect(node.versions[0]?.header).toBe('Neuron structure');
    expect(node.versions[0]?.media?.freeImage).toMatchObject({
      source: 'wikimedia', sourceId: 'File:Neuron.jpg',
      license: 'CC BY 4.0', creditLine: 'Researcher / Wikimedia Commons',
    });
    expect(Object.values(project.arrows).some(
      (arrow) => arrow.fromNodeId === 'parent' && arrow.toNodeId === nodeId,
    )).toBe(true);
    expect(saveAsset).toHaveBeenCalledOnce();
    expect(useGraphStore.temporal.getState().pastStates.length).toBeGreaterThan(0);
  });

  it('stores Openverse provenance through the same undoable spawn path', async () => {
    const nodeId = await spawnWikimediaImageNode('parent', {
      source: 'openverse', sourceId: 'ov-1',
      landingPageUrl: 'https://example.org/work/1',
      thumbnailUrl: 'https://api.openverse.org/thumb/1',
      originalUrl: 'https://example.org/original.jpg',
      caption: 'Therapy chair', creator: 'Jane Doe', creatorUrl: 'https://example.org/jane',
      license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      creditLine: '“Therapy chair” by Jane Doe is licensed under CC BY 4.0.',
    });
    expect(useGraphStore.getState().project!.nodes[nodeId]!.versions[0]?.media?.freeImage)
      .toMatchObject({
        source: 'openverse', sourceId: 'ov-1', landingPageUrl: 'https://example.org/work/1',
        creator: 'Jane Doe', license: 'CC BY 4.0',
      });
  });
});
