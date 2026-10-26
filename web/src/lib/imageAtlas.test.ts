import { describe, expect, it } from 'vitest';
import type { Arrow, ImageQuestionContext, ScatterNode } from '@/store/types';
import { imageArrowCandidates, imageArrowContext, imageAtlasFrame, imageContextMatches } from './imageAtlas';
import { sourcePortToward } from '@/physics/sourcePort';

const context: ImageQuestionContext = { sourceMedia: { source: 'asset', kind: 'image', assetId: 'photo' }, sourceVersionCreatedAt: 1,
  regions: [{ x: .1, y: .2, width: .4, height: .2 }] };
const node: ScatterNode = { id: 'image', type: 'media', position: { x: 100, y: 200 }, frozen: true, currentVersionIndex: 0,
  versions: [{ header: 'Image', body: '', createdAt: 1, generatedBy: 'media', media: context.sourceMedia }] };
const arrow: Arrow = { id: 'a', fromNodeId: 'image', toNodeId: 'child', kind: 'auto' };
describe('image atlas origins', () => {
  it('indexes candidate links once per arrow map and leaves ordinary labelled links out', () => {
    const arrows = { atlas: { ...arrow, sourceImage: context }, ordinary: { ...arrow, id: 'ordinary', label: 'term' } };
    const candidates = imageArrowCandidates(arrows, 'image');
    expect(candidates).toEqual([arrows.atlas]);
    expect(imageArrowCandidates(arrows, 'image')).toBe(candidates);
    expect(imageArrowCandidates(arrows, 'missing')).toEqual([]);
    expect(imageArrowCandidates({}, 'image')).toEqual([]);
  });
  it('maps normalized regions through the actual letterboxed bitmap, not the node rectangle', () => {
    const frame = imageAtlasFrame(context, { x: 40, y: 80, width: 600, height: 300 })!;
    const origin = sourcePortToward(frame.port, { x: 100, y: 200 }, { x: 1000, y: 370 });
    expect(origin.x).toBeCloseTo(440);
    expect(origin.y).toBeCloseTo(370);
  });
  it('keeps origins inside irregular unions and disconnected regions', () => {
    const cases = [
      [{ x: 0, y: 0, width: .2, height: 1 }, { x: 0, y: .8, width: 1, height: .2 }],
      [{ x: 0, y: 0, width: .2, height: .2 }, { x: .8, y: .8, width: .2, height: .2 }],
    ];
    for (const regions of cases) {
      const p = imageAtlasFrame({ ...context, regions }, { x: 0, y: 0, width: 1, height: 1 })!.port.center;
      expect(regions.some((r) => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height)).toBe(true);
    }
    expect(imageAtlasFrame({ ...context, regions: [] }, { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });
  it('retains atlas regions for title-only versions, never for different image pixels', () => {
    expect(imageContextMatches(context, node)).toBe(true);
    expect(imageContextMatches(context, { ...node, versions: [{ ...node.versions[0]!, createdAt: 2, header: 'Renamed' }] })).toBe(true);
    expect(imageContextMatches(context, { ...node, versions: [{ ...node.versions[0]!, media: { ...context.sourceMedia, assetId: 'edited' } }] })).toBe(false);
  });
  it('caches rounded geometry instead of rebuilding it on movement or focus', () => {
    const rect = { x: 20, y: 60, width: 600, height: 400 };
    expect(imageAtlasFrame(context, rect)).toBe(imageAtlasFrame(context, rect));
  });
  it('supports earlier image questions without treating ordinary or whole-image arrows as atlas links', () => {
    const child = { ...node, versions: [{ ...node.versions[0]!, generatedBy: 'follow-up' as const, imageContext: context }] };
    expect(imageArrowContext(arrow, child)).toBe(context);
    expect(imageArrowContext({ ...arrow, sourceImage: context })).toBe(context);
    expect(imageArrowContext(arrow, node)).toBeUndefined();
    expect(imageArrowContext({ ...arrow, label: 'term' }, child)).toBeUndefined();
    expect(imageArrowContext({ ...arrow, sourceImage: { ...context, regions: [] } }, child)).toBeUndefined();
  });
});
