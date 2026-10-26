import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { spawnTermClick } from './generate';
import { activateReference } from './referenceAction';

vi.mock('./generate', () => ({ spawnTermClick: vi.fn().mockResolvedValue('new-node') }));
beforeEach(() => {
  vi.mocked(spawnTermClick).mockClear();
  const project = createBlankProject('References', 'parent');
  const base = { type: 'term-click' as const, position: { x: 0, y: 0 }, frozen: true, versions: [], currentVersionIndex: 0 };
  useGraphStore.getState().setProject({ ...project,
    nodes: { parent: { ...base, id: 'parent' }, child: { ...base, id: 'child' } },
    arrows: { link: { id: 'link', fromNodeId: 'parent', toNodeId: 'child', kind: 'auto', label: 'Known' } },
  });
  useGraphStore.getState().requestPanTo(null);
});
describe('term activation', () => {
  it('navigates existing relations without creating another node', () => {
    expect(activateReference('parent', 'Known', { withModifier: false }).kind).toBe('existing');
    expect(useGraphStore.getState().panTo).toMatchObject({ kind: 'node', id: 'child' });
    expect(spawnTermClick).not.toHaveBeenCalled();
  });
  it('forwards modifier options for new references', () => {
    expect(activateReference('parent', 'New', { withModifier: true }).kind).toBe('spawned');
    expect(spawnTermClick).toHaveBeenCalledWith('parent', 'New', expect.objectContaining({ bulletsCollapsed: true }));
    expect(useGraphStore.getState().panTo).toBeNull();
  });
  it('does not navigate a dangling relationship to a deleted child', () => {
    const project = useGraphStore.getState().project!;
    useGraphStore.getState().setProject({ ...project, nodes: { parent: project.nodes.parent! } });
    expect(activateReference('parent', 'Known', { withModifier: false }).kind).toBe('spawned');
    expect(spawnTermClick).toHaveBeenCalledOnce();
  });
});
