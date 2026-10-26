import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WikimediaDiscoveryCoordinator } from './WikimediaDiscoveryCoordinator';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { beginGenerationSession, resetGenerationSessionsForTests } from '@/lib/generationSession';
import type { ScatterNode } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';

const start = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/wikimediaDiscovery', async original => ({
  ...await original<typeof import('@/lib/wikimediaDiscovery')>(),
  startWikimediaDiscovery: start, wikimediaSearchAvailability: () => ({ available: true }),
}));
beforeEach(() => {
  useSettingsStore.setState({ autoFreeImages: true });
  start.mockClear(); resetGenerationSessionsForTests(); vi.useFakeTimers();
  const node: ScatterNode = { id: 'n', type: 'root', frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0,
    versions: [{ header: 'Topic', body: 'Complete old prose.', createdAt: 1, generatedBy: 'root' }] };
  useGraphStore.getState().setProject({ ...createBlankProject('Images', 'n'), nodes: { n: node }, selection: ['n'] });
});
afterEach(() => { resetGenerationSessionsForTests(); vi.useRealTimers(); });

describe('automatic image discovery lifecycle', () => {
  it.each(['explain', 'interactive'] as const)('skips old and newly generated %s versions, including legacy nodes', type => {
    const node = useGraphStore.getState().project!.nodes.n!;
    useGraphStore.getState().updateNode('n', { type });
    render(<WikimediaDiscoveryCoordinator />);
    act(() => {
      useGraphStore.getState().updateNode('n', { currentVersionIndex: 1,
        versions: [...node.versions, { ...node.versions[0]!, contentType: type, createdAt: 2 }] });
      vi.advanceTimersByTime(5000);
    });
    expect(start).not.toHaveBeenCalled();
  });
  it('uses each version’s format when an explain node is converted to encyclopedic', () => {
    const node = useGraphStore.getState().project!.nodes.n!;
    useGraphStore.getState().updateNode('n', { type: 'explain', versions: [
      node.versions[0]!, { ...node.versions[0]!, contentType: 'encyclopedic', createdAt: 2 },
    ], currentVersionIndex: 1 });
    render(<WikimediaDiscoveryCoordinator />);
    expect(start).toHaveBeenCalledExactlyOnceWith('n', 2, { automatic: true });
  });
  it('never automatically searches images for custom text nodes, including after edits', () => {
    const node = useGraphStore.getState().project!.nodes.n!;
    useGraphStore.getState().updateNode('n', { versions: [{ ...node.versions[0]!, markdownNote: true, contentType: 'answer' }] });
    render(<WikimediaDiscoveryCoordinator />);
    act(() => {
      const current = useGraphStore.getState().project!.nodes.n!;
      useGraphStore.getState().updateNode('n', { versions: [...current.versions, { ...current.versions[0]!, createdAt: 2 }] });
      vi.advanceTimersByTime(5000);
    });
    expect(start).not.toHaveBeenCalled();
  });
  it('waits until the startup canvas is revealed', () => {
    const { rerender } = render(<WikimediaDiscoveryCoordinator enabled={false} />);
    expect(start).not.toHaveBeenCalled();
    rerender(<WikimediaDiscoveryCoordinator enabled />);
    expect(start).toHaveBeenCalledWith('n', 1, { automatic: true });
  });
  it('does not automatically search while disabled and starts on enabling', () => {
    useSettingsStore.setState({ autoFreeImages: false });
    render(<WikimediaDiscoveryCoordinator />);
    expect(start).not.toHaveBeenCalled();
    act(() => useSettingsStore.setState({ autoFreeImages: true }));
    expect(start).toHaveBeenCalledWith('n', 1, { automatic: true });
  });
  it('does not search an inherited provisional body during a rewrite session', () => {
    const project = useGraphStore.getState().project!;
    beginGenerationSession({ projectId: project.id, nodeId: 'n', kind: 'rewrite', sourceVersionIndex: 0, draftVersionIndex: 1 });
    render(<WikimediaDiscoveryCoordinator />);
    act(() => {
      useGraphStore.getState().updateNode('n', { currentVersionIndex: 1, versions: [
        ...project.nodes.n!.versions, { ...project.nodes.n!.versions[0]!, createdAt: 2 },
      ] });
      vi.advanceTimersByTime(1000);
    });
    expect(start).not.toHaveBeenCalled();
  });
  it('does not search a failed incomplete generation', () => {
    useGraphStore.getState().updateNode('n', { generationError: 'Output limit reached.' });
    render(<WikimediaDiscoveryCoordinator />);
    expect(start).not.toHaveBeenCalled();
  });
});
