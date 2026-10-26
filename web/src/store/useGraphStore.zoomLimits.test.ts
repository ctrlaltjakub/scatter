import { afterEach, describe, expect, it } from 'vitest';
import { createBlankProject, useGraphStore } from './useGraphStore';

afterEach(() => useGraphStore.getState().setProject(null));

describe('persisted viewport zoom limits', () => {
  it('caps a loaded legacy project at 150%', () => {
    const project = createBlankProject('legacy zoom', 'root');
    useGraphStore.getState().setProject({
      ...project,
      viewport: { x: 8, y: 9, zoom: 2 },
    });
    expect(useGraphStore.getState().project?.viewport).toEqual({ x: 8, y: 9, zoom: 1.5 });
  });

  it('caps persisted camera updates at 150%', () => {
    useGraphStore.getState().setProject(createBlankProject('zoom', 'root'));
    useGraphStore.getState().setViewport({ x: 8, y: 9, zoom: 2 });
    expect(useGraphStore.getState().project?.viewport).toEqual({ x: 8, y: 9, zoom: 1.5 });
  });
});
