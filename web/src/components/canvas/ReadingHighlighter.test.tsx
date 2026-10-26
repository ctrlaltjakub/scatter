import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useReadingStore } from '@/store/useReadingStore';
import { ReadingHighlighter } from './ReadingHighlighter';
import { appendChatAnswer, createChatNode } from '@/lib/chat/model';

const controller = vi.hoisted(() => ({
  exitReading: vi.fn(),
  reconcileReading: vi.fn(),
  readingSurfaceFor: vi.fn((nodeId: string) => document.querySelector(`[data-node-id="${nodeId}"]`)),
}));

vi.mock('@/lib/readingController', () => controller);

function seed() {
  const node: ScatterNode = {
    id: 'n0', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: 'Node', body: 'Initial text', createdAt: 0, generatedBy: 'term-click' }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('reading-stream', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node }, selection: [node.id] });
  useReadingStore.getState().begin(node.id, 0, 0, null);
}

beforeEach(() => {
  controller.exitReading.mockReset();
  controller.reconcileReading.mockReset();
  controller.readingSurfaceFor.mockClear();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(performance.now());
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  seed();
});

describe('ReadingHighlighter streaming reconciliation', () => {
  it('keeps the ruler when crossing chat turns without reconciling physics writes', () => {
    let chat = createChatNode({ id: 'n0', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 600 });
    chat = appendChatAnswer(chat, { turnId: 't', createdAt: 2, question: 'Question' });
    useGraphStore.getState().updateNode('n0', { ...chat, generating: false });
    render(<ReadingHighlighter />);
    act(() => { useGraphStore.getState().updateNode('n0', { currentVersionIndex: 0, position: { x: 1, y: 2 } }); });
    expect(controller.exitReading).not.toHaveBeenCalled();
    expect(controller.reconcileReading).not.toHaveBeenCalled();
    act(() => { useGraphStore.getState().updateNode('n0', { versions: chat.versions.map((version) => ({ ...version, body: 'More text.' })) }); });
    expect(controller.reconcileReading).toHaveBeenCalledWith('n0');
  });
  it('keeps reading active when generation starts and reconciles after the graph update', () => {
    render(<ReadingHighlighter />);
    act(() => {
      const node = useGraphStore.getState().project!.nodes.n0!;
      const versions = [...node.versions];
      versions[0] = { ...versions[0]!, body: '' };
      useGraphStore.getState().updateNode('n0', { generating: true, versions });
    });
    expect(controller.exitReading).not.toHaveBeenCalled();
    expect(controller.reconcileReading).toHaveBeenCalledWith('n0');
  });

  it('observes rendered text mutations and schedules a repaint', async () => {
    const { container } = render(
      <div data-node-id="n0"><span>Initial text</span><ReadingHighlighter /></div>,
    );
    controller.reconcileReading.mockClear();
    act(() => { container.querySelector('span')!.textContent = 'Streamed text'; });
    await waitFor(() => expect(controller.reconcileReading).toHaveBeenCalledWith('n0'));
    expect(controller.exitReading).not.toHaveBeenCalled();
  });
});
