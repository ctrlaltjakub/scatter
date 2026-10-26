import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createImageArrowSourceSync } from './imageArrowSourceSync';
import { createBlankProject } from '@/store/useGraphStore';
import { useImageGeometryStore } from '@/store/useImageGeometryStore';
import type { PhysicsClient } from '@/physics/physicsClient';

const project = () => {
  const p = createBlankProject('Test', 'image');
  const media = { kind: 'image' as const, source: 'asset' as const, assetId: 'photo' };
  p.nodes.image = { id: 'image', type: 'media', frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0,
    versions: [{ header: 'Image', body: '', createdAt: 1, generatedBy: 'media', media }] };
  p.arrows.a = { id: 'a', fromNodeId: 'image', toNodeId: 'child', kind: 'auto', sourceImage: { sourceMedia: media, regions: [{ x: .1, y: .1, width: .2, height: .2 }] } };
  useImageGeometryStore.getState().set('image', { projectId: p.id, mediaKey: 'asset:photo', owner: Symbol(), rect: { x: 20, y: 50, width: 400, height: 300 } });
  return p;
};
beforeEach(() => useImageGeometryStore.setState({ byNode: {} }));
describe('image source geometry synchronization', () => {
  it('sends one port, not repeated messages for selection, motion, or body changes', () => {
    const p = project(), setArrowSources = vi.fn();
    const { sync } = createImageArrowSourceSync({ setArrowSources } as unknown as PhysicsClient);
    sync(p);
    sync({ ...p, selection: ['image'] });
    sync({ ...p, nodes: { ...p.nodes, image: { ...p.nodes.image!, position: { x: 20, y: 50 } } } });
    expect(setArrowSources).toHaveBeenCalledTimes(1);
    expect(setArrowSources.mock.calls[0]![0][0].sourcePort.contours).toHaveLength(1);
  });
  it('resets only the special source when the displayed image changes', () => {
    const p = project(), setArrowSources = vi.fn();
    const { sync } = createImageArrowSourceSync({ setArrowSources } as unknown as PhysicsClient);
    sync(p);
    const n = p.nodes.image!, v = n.versions[0]!;
    sync({ ...p, nodes: { image: { ...n, versions: [{ ...v, media: { ...v.media!, assetId: 'another' } }] } } });
    expect(setArrowSources).toHaveBeenLastCalledWith([{ arrowId: 'a', sourcePort: undefined }]);
  });
  it('waits for the worker link and resends after link replacement/undo', () => {
    const p = project(), setArrowSources = vi.fn();
    let ready = false;
    const sources = createImageArrowSourceSync({ setArrowSources } as unknown as PhysicsClient, () => ready);
    sources.sync(p);
    expect(setArrowSources).not.toHaveBeenCalled();
    ready = true; sources.forget('a'); sources.sync(p);
    expect(setArrowSources).toHaveBeenCalledTimes(1);
    sources.forget('a'); sources.sync(p);
    expect(setArrowSources).toHaveBeenCalledTimes(2);
  });
  it('does no messaging for ordinary arrows', () => {
    const p = project(), setArrowSources = vi.fn();
    p.arrows.a = { ...p.arrows.a!, sourceImage: undefined, label: 'term' };
    createImageArrowSourceSync({ setArrowSources } as unknown as PhysicsClient).sync(p);
    expect(setArrowSources).not.toHaveBeenCalled();
  });
});
