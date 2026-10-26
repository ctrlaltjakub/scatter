import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';
import { annotateChatMarkdown } from '@/lib/chat/markdown';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { activateReference } from '@/lib/referenceAction';
import type { Arrow, NodeVersion } from '@/store/types';

vi.mock('@/lib/chat/markdown', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/chat/markdown')>();
  return { ...actual, annotateChatMarkdown: vi.fn(actual.annotateChatMarkdown) };
});
vi.mock('@/lib/chat/actions', () => ({ activateChatAnswer: vi.fn() }));
vi.mock('@/lib/referenceAction', () => ({ activateReference: vi.fn() }));
const BODY = 'Support **connection** through [[therapy]].\n\n| Method | Value |\n|---|---|\n| Practice | Useful |';

function fixture() {
  let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 600 });
  for (const createdAt of [2, 3]) {
    node = appendChatAnswer(node, { turnId: 'turn', createdAt, question: 'Question', replaceLatest: createdAt === 3 });
    node = updateChatAnswer(node, { turnId: 'turn', versionCreatedAt: createdAt }, { body: BODY }, { state: 'complete' });
  }
  const arrows: Record<string, Arrow> = {
    old: { id: 'old', kind: 'auto', fromNodeId: 'chat', toNodeId: 'old-child', label: 'therapy',
      sourceAnswer: { turnId: 'turn', versionCreatedAt: 2 } },
    new: { id: 'new', kind: 'dotted', fromNodeId: 'chat', toNodeId: 'new-child', label: 'therapy',
      sourceAnswer: { turnId: 'turn', versionCreatedAt: 3 } },
    passage: { id: 'passage', kind: 'auto', fromNodeId: 'chat', toNodeId: 'passage-child',
      sourceAnswer: { turnId: 'turn', versionCreatedAt: 2 },
      sourceSelection: { sourceVersionCreatedAt: 2, createdAt: 4, text: 'connection',
        parts: [{ sourceField: 'chat:0', start: BODY.indexOf('connection'), end: BODY.indexOf('connection') + 10, text: 'connection' }] } },
  };
  const project = createBlankProject('chat focus', 'chat');
  useGraphStore.setState({ project: { ...project, nodes: { chat: node }, arrows, selection: [] }, highlight: null });
  useGraphStore.temporal.getState().pause();
  return { old: node.versions.find(v => v.createdAt === 2)!, next: node.versions.find(v => v.createdAt === 3)!, project };
}
beforeEach(() => { vi.clearAllMocks(); useLiveViewportStore.getState().clear(); useCitationPanelStore.getState().close(); });
afterEach(() => { cleanup(); useGraphStore.getState().setProject(null); useGraphStore.temporal.getState().resume(); });

describe('chat focus rendering isolation', () => {
  it('ignores unrelated panel changes, including fact-review units on other answers', () => {
    const { old } = fixture();
    let commits = 0;
    render(<Profiler id="chat" onRender={() => { commits++; }}><ChatMarkdown nodeId="chat" version={old} /></Profiler>);
    commits = 0;
    act(() => useCitationPanelStore.getState().openConversation('other-chat'));
    expect(commits).toBe(0);
    act(() => useCitationPanelStore.getState().openWikimedia('chat', 1));
    act(() => useCitationPanelStore.getState().openFact('chat', 3, 'chat:0'));
    act(() => useCitationPanelStore.getState().setFactUnit('chat', 'chat:1'));
    act(() => useCitationPanelStore.getState().close());
    expect(commits).toBe(0);
  });

  it('ignores unrelated focus, preserves exact answer scopes, and never reparses for highlights', () => {
    const { old, next } = fixture();
    let commits = 0;
    const onRender = () => { commits++; };
    const { container, rerender } = render(<Profiler id="chat" onRender={onRender}><ChatMarkdown nodeId="chat" version={old} /></Profiler>);
    const table = screen.getByRole('region', { name: 'Scrollable table' });
    table.scrollLeft = 37;
    vi.mocked(annotateChatMarkdown).mockClear(); commits = 0;
    act(() => useGraphStore.getState().setSelection(['unrelated']));
    act(() => useGraphStore.getState().setSelection(['new-child']));
    expect(commits).toBe(0);

    act(() => useGraphStore.getState().setSelection(['old-child']));
    expect(screen.getByRole('button', { name: 'therapy' })).toHaveClass('active');
    expect(annotateChatMarkdown).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Scrollable table' })).toBe(table);
    expect(table.scrollLeft).toBe(37);
    act(() => useGraphStore.getState().setSelection(['old-child', 'unrelated']));
    expect(screen.getByRole('button', { name: 'therapy' })).not.toHaveClass('active');

    act(() => useGraphStore.getState().setSelection(['passage-child']));
    expect(container.querySelector('.source-selection-mark.active')).toHaveTextContent('connection');
    act(() => useGraphStore.setState({ highlight: {
      parentNodeId: 'chat', childNodeId: 'passage-child', arrowId: 'passage', source: 'node', nonce: 1,
    } }));
    act(() => useGraphStore.getState().setSelection([]));
    expect(container.querySelector('.source-selection-mark.active')).toHaveTextContent('connection');
    act(() => useGraphStore.setState({ highlight: null }));
    expect(container.querySelector('.source-selection-mark.active')).toBeNull();
    expect(annotateChatMarkdown).not.toHaveBeenCalled();

    act(() => useGraphStore.getState().setSelection(['new-child']));
    rerender(<Profiler id="chat" onRender={onRender}><ChatMarkdown nodeId="chat" version={next} /></Profiler>);
    expect(screen.getByRole('button', { name: 'therapy' })).toHaveClass('active');
    expect(container.querySelector('.source-selection-mark')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'therapy' }));
    expect(activateReference).toHaveBeenLastCalledWith('chat', 'therapy', {
      withModifier: false, sourceAnswer: { turnId: 'turn', versionCreatedAt: 3 },
    });
  });

  it('invalidates content caches for edits, chunking and newly added relations', () => {
    const { old } = fixture();
    const { container, rerender } = render(<ChatMarkdown nodeId="chat" version={old} />);
    vi.mocked(annotateChatMarkdown).mockClear();
    const changed = { ...old, body: old.body + '\n\nAnother **sentence**.',
      chat: { ...old.chat!, informationChunking: true } };
    rerender(<ChatMarkdown nodeId="chat" version={changed} />);
    expect(annotateChatMarkdown).toHaveBeenCalled();
    expect(container.querySelector('.sc-ab-sentence')).not.toBeNull();
    expect(container).toHaveTextContent('Another sentence.');
    const previous = useGraphStore.getState().project!;
    const { passage, ...remainingArrows } = previous.arrows;
    act(() => useGraphStore.setState({ project: { ...previous, arrows: remainingArrows } }));
    expect(container.querySelector('.source-selection-mark')).toBeNull();
    act(() => useGraphStore.getState().addArrow(passage!));
    expect(container.querySelector('.source-selection-mark')).toHaveTextContent('connection');
  });

  it('updates fact-review presentation without parsing again or resetting tables', () => {
    const { old } = fixture();
    const version: NodeVersion = { ...old, factCheck: { complete: {
      schemaVersion: 1, bodyFingerprint: 'test', versionCreatedAt: 2, providerId: 'test', model: 'test',
      startedAt: 1, complete: true, failedUnitIds: [],
      units: [{ id: 'chat:0', order: 0, stage: 'prose', kind: 'sentence', text: 'Support connection', state: 'pending' }],
    } } };
    const onUnit = vi.fn();
    const { container, rerender } = render(<ChatMarkdown nodeId="chat" version={version} localEvidence={{ activeId: null, onUnit }} />);
    const unit = container.querySelector<HTMLElement>('[data-fact-unit="chat:0"]')!;
    expect(unit).toHaveAttribute('data-tip', 'Review evidence');
    expect(unit).toHaveAttribute('aria-label', 'Review evidence for: Support connection');
    vi.mocked(annotateChatMarkdown).mockClear();
    rerender(<ChatMarkdown nodeId="chat" version={version} localEvidence={{ activeId: 'chat:0', onUnit }} />);
    expect(container.querySelector('[data-fact-unit="chat:0"]')).toBe(unit);
    expect(unit).toHaveClass('fact-active');
    fireEvent.keyDown(unit, { key: 'Enter' });
    expect(onUnit).toHaveBeenCalledWith('chat:0');
    // A local viewer must not borrow the canvas panel's active unit.
    rerender(<ChatMarkdown nodeId="chat" version={version} localEvidence={{ activeId: null, onUnit }} />);
    act(() => useCitationPanelStore.getState().openFact('chat', 2, 'chat:0'));
    expect(unit).not.toHaveClass('fact-active');
    // Back on the canvas, the exact answer's panel drives presentation.
    rerender(<ChatMarkdown nodeId="chat" version={version} />);
    expect(container.querySelector('[data-fact-unit="chat:0"]')).toBe(unit);
    expect(unit).toHaveClass('fact-active');
    act(() => useCitationPanelStore.getState().setFactUnit('chat', 'different-unit'));
    expect(unit).not.toHaveClass('fact-active');
    expect(unit).toHaveClass('fact-check-unit');
    act(() => useCitationPanelStore.getState().openFact('chat', 3, 'chat:0'));
    expect(container.querySelector('.fact-check-unit')).toBeNull();
    act(() => useCitationPanelStore.getState().openFact('chat', 2, 'chat:0'));
    expect(unit).toHaveClass('fact-active');
    act(() => useCitationPanelStore.getState().close());
    expect(container.querySelector('.fact-check-unit')).toBeNull();
    expect(annotateChatMarkdown).not.toHaveBeenCalled();
  });
});
