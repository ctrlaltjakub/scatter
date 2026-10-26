// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { activateChatAnswer } from '@/lib/chat/actions';
import { NodeSidePanel, PANEL_GAP } from './NodeSidePanel';

function installNode(chat = false) {
  const node: ScatterNode = {
    id: 'search-panel', type: 'root', position: { x: 0, y: 0 }, frozen: true,
    currentVersionIndex: 0,
    versions: ['First search', 'Second search', undefined].map((text, index) => ({
      header: 'Search answer', body: 'Opening paragraph.\n\n- Topic\n  - Detail',
      createdAt: index + 1, generatedBy: 'root', contentType: chat ? 'chat' : 'encyclopedic',
      googleSearchSuggestions: text ? [`<div>${text}</div>`] : undefined,
      ...(chat ? { chat: { turnId: `turn-${index}`, question: 'Question', title: 'Answer',
        informationChunking: false, state: 'complete', contextPath: [] } as const } : {}),
    })),
    ...(chat ? { chat: { title: 'Conversation', informationChunking: false,
      turns: [0, 1, 2].map(index => ({ id: `turn-${index}`, versionCreatedAts: [index + 1], selectedVersionCreatedAt: index + 1 })),
      parentSnapshots: {}, compactions: [] } } : {}),
  };
  const project = createBlankProject('search-panel-test', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node }, selection: [node.id] });
  useGraphStore.temporal.getState().pause();
  return node;
}

describe('detached Gemini search panel', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    useChatRuntimeStore.setState({ views: {} });
  });
  afterEach(() => vi.restoreAllMocks());

  it('shares the moving/measured stack with the actions and uses the node gap', () => {
    installNode();
    const { container } = render(<NodeSidePanel />);
    const stack = container.querySelector<HTMLElement>('.node-actions-panel')!;
    const panel = screen.getByRole('region', { name: 'Gemini API search suggestions' });
    expect(stack.style.gap).toBe(`${PANEL_GAP}px`);
    expect(panel.parentElement).toBe(stack);
    expect(panel.previousElementSibling).toHaveClass('side-panel');
    expect(panel.querySelector('h3')).toHaveTextContent('Forced by Gemini API:');
    expect(panel.querySelector('.google-search-suggestions-label')).toBeNull();
    const frame = panel.querySelector('iframe')!;
    expect(frame.srcdoc).toContain('First search');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(panel.querySelector('iframe')).toBe(frame);
    expect(panel.previousElementSibling).toHaveTextContent('Edit or export text');
  });

  it('shows only the active version and removes the empty panel for ungrounded versions', () => {
    const node = installNode();
    const { container } = render(<NodeSidePanel />);
    for (const [index, text] of [[0, 'First search'], [1, 'Second search'], [2, undefined], [0, 'First search']] as const) {
      act(() => useGraphStore.getState().updateNode(node.id, { currentVersionIndex: index }));
      const frames = container.querySelectorAll('iframe');
      expect(frames).toHaveLength(text ? 1 : 0);
      expect(container.querySelectorAll('.google-search-panel')).toHaveLength(text ? 1 : 0);
      if (text) expect(frames[0]!.srcdoc).toContain(text);
    }
  });

  it('follows the active chat answer, without combining other answers or versions', () => {
    const node = installNode(true);
    const { container } = render(<NodeSidePanel />);
    act(() => activateChatAnswer(node.id, { turnId: 'turn-1', versionCreatedAt: 2 }));
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    expect(container.querySelector('iframe')!.srcdoc).toContain('Second search');
    expect(container.querySelector('iframe')!.srcdoc).not.toContain('First search');
    act(() => activateChatAnswer(node.id, { turnId: 'turn-2', versionCreatedAt: 3 }));
    expect(container.querySelector('.google-search-panel')).toBeNull();
  });

  it('does not collapse the supplied content when the focused node’s bullets collapse', () => {
    const node = installNode();
    const { container } = render(<NodeSidePanel />);
    act(() => useGraphStore.getState().updateNode(node.id, { bulletsCollapsed: true }));
    expect(container.querySelectorAll('.google-search-panel iframe')).toHaveLength(1);
    act(() => useGraphStore.getState().setSelection([]));
    expect(container.querySelector('.node-actions-panel')).toBeNull();
  });
});
