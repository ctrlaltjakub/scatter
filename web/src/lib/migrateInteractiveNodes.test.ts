import { describe, expect, it } from 'vitest';
import { createBlankProject } from '@/store/useGraphStore';
import type { NodeVersion, ScatterNode } from '@/store/types';
import { migrateInteractiveNodes } from './migrateInteractiveNodes';

function legacy() {
  const project = createBlankProject('Older project', 'old');
  const version: NodeVersion & { interactiveProseWidth: number } = {
    header: 'Resonance - explained', body: 'Original [[resonance]] explanation.⟦1⟧', createdAt: 10,
    generatedBy: 'interactive', contentType: 'interactive', width: 764, interactiveProseWidth: 700,
    sources: [{ n: 1, url: 'https://example.com', domain: 'example.com' }],
    interactive: { html: '<!doctype html><html><body>Original program</body></html>', request: 'Demonstrate resonance',
      model: 'old-model', providerId: 'old-provider', viewportSize: 580 },
  };
  project.nodes.old = { id: 'old', type: 'explain', frozen: true, groupId: 'g', position: { x: 50, y: 60 }, versions: [version], currentVersionIndex: 0 };
  project.arrows.link = { id: 'link', fromNodeId: 'old', toNodeId: 'term', kind: 'auto' };
  return project;
}

describe('legacy interactive migration', () => {
  it('preserves prose, sources and links, extracting saved code without changing it', () => {
    const before = legacy(); const original = structuredClone(before);
    const after = migrateInteractiveNodes(before);
    expect(before).toEqual(original);
    expect(after.nodes.old?.versions[0]).toMatchObject({ body: before.nodes.old!.versions[0]!.body, contentType: 'explain', width: 700 });
    expect(after.nodes.old?.versions[0]?.interactive).toBeUndefined();
    expect(after.nodes.old?.versions[0]?.sources).toEqual(before.nodes.old!.versions[0]!.sources);
    const program = after.nodes['old-interactive']!;
    expect(program).toMatchObject({ type: 'interactive', frozen: true, groupId: 'g', legacyInteractiveSourceId: 'old' });
    expect(program.versions[0]).toMatchObject({ header: 'Resonance', contentType: 'interactive', interactiveStandalone: true });
    expect(program.versions[0]?.interactive).toEqual(before.nodes.old?.versions[0]?.interactive);
    expect(after.arrows.link).toBe(before.arrows.link);
    expect(Object.values(after.arrows)).toContainEqual(expect.objectContaining({ fromNodeId: 'old', toNodeId: program.id }));
  });
  it('is deterministic and a no-op on repeated loads', () => {
    const before = legacy(); const after = migrateInteractiveNodes(before);
    expect(migrateInteractiveNodes(before)).toEqual(after);
    expect(migrateInteractiveNodes(after)).toBe(after);
    expect(migrateInteractiveNodes(createBlankProject('Empty', 'root')).nodes).toEqual({});
  });
  it('extracts all historical program versions without changing the current text version', () => {
    const project = legacy(); const n = project.nodes.old!;
    n.versions.push({ ...n.versions[0]!, createdAt: 20 }, { header: 'New text', body: 'More prose', createdAt: 30, generatedBy: 'explain', contentType: 'explain' });
    n.currentVersionIndex = 2;
    const result = migrateInteractiveNodes(project);
    expect(result.nodes.old?.currentVersionIndex).toBe(2);
    expect(result.nodes.old?.versions[2]).toBe(n.versions[2]);
    expect(result.nodes['old-interactive']?.versions.map(v => v.createdAt)).toEqual([10, 20]);
    expect(result.nodes['old-interactive']?.currentVersionIndex).toBe(1);
  });
  it('handles interrupted older generations without launching any API request', () => {
    const project = legacy(); project.nodes.old!.versions[0]!.interactive = undefined;
    const result = migrateInteractiveNodes(project);
    expect(result.nodes['old-interactive']?.versions[0]?.interactiveBuild).toMatchObject({ state: 'failed', request: 'Resonance' });
    expect(result.nodes['old-interactive']?.versions[0]?.interactiveBuild?.error).toContain('no saved program');
  });
  it('keeps modern dedicated nodes unchanged', () => {
    const project = legacy(); project.nodes.old!.versions[0]!.interactiveStandalone = true;
    expect(migrateInteractiveNodes(project)).toBe(project);
  });
  it('does not duplicate or overwrite an extracted program when stale prose is synced', () => {
    const before = legacy(); const result = migrateInteractiveNodes(before);
    const program = result.nodes['old-interactive']!;
    program.versions.push({ ...program.versions[0]!, createdAt: 30, header: 'User changes' });
    program.currentVersionIndex = 1;
    const synced = migrateInteractiveNodes({ ...result, nodes: { ...result.nodes, old: before.nodes.old! } });
    expect(Object.keys(synced.nodes)).toHaveLength(2);
    expect(synced.nodes[program.id]?.versions).toHaveLength(2);
    expect(synced.nodes[program.id]?.versions[1]?.header).toBe('User changes');
    expect(synced.nodes[program.id]?.currentVersionIndex).toBe(1);
    expect(Object.keys(synced.arrows)).toHaveLength(2);
  });
  it('avoids existing node IDs and overlapping cards', () => {
    const project = legacy();
    const blocker: ScatterNode = { ...project.nodes.old!, id: 'old-interactive', position: { x: 846, y: 60 }, versions: [{ header: 'Existing', body: '', createdAt: 1, generatedBy: 'manual', contentType: 'explain' }] };
    project.nodes[blocker.id] = blocker;
    const result = migrateInteractiveNodes(project);
    expect(result.nodes[blocker.id]).toBe(blocker);
    expect(result.nodes['old-interactive-1']?.position.y).toBeGreaterThan(blocker.position.y + 720);
  });
});
