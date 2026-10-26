import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerBody } from './AnswerBody';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useChatTableStore } from '@/store/useChatTableStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import type { ScatterNode } from '@/store/types';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useChatRuntimeStore.setState({ views: {} });
  useChatTableStore.getState().close();
  useCitationPanelStore.getState().close();
});

describe('standalone answer presentation', () => {
  it.each([true, false])('preserves the original Markdown and enrichment (chunked=%s)', (informationChunking) => {
    let chat = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    chat = appendChatAnswer(chat, { turnId: 'turn', createdAt: 2, question: 'Original question', metadata: { informationChunking } });
    chat = updateChatAnswer(chat, { turnId: 'turn', versionCreatedAt: 2 }, {
      body: 'First idea. Second idea.\n\nA **[[learning term]]** matters. (1) Another fact. ⟦2⟧\n\nLine one,\\\nline two.\n\n| Name | Value |\n|---|---|\n| Go | 19 |',
      sources: [{ n: 2, url: 'https://example.com', title: 'Web source' }],
      internalSources: [{ n: 1, sourceId: 's', revisionId: 'r', passageId: 'p', sourceTitle: 'Notes', excerpt: 'Fact' }],
    }, { state: 'complete' });
    const version = { ...chat.versions[1]!, contentType: 'answer' as const };
    const node: ScatterNode = { id: 'answer', type: 'follow-up', position: { x: 0, y: 0 }, frozen: false,
      versions: [version], currentVersionIndex: 0 };
    const project = { ...createBlankProject('Answer', node.id), nodes: { [node.id]: node } };
    useGraphStore.setState({ project });
    const zoom = vi.fn();
    const { container } = render(<div onWheel={zoom}><AnswerBody node={node} selected /></div>);
    expect(container.querySelector('.sc-ab-sentence') !== null).toBe(informationChunking);
    expect(container.querySelectorAll('br')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'learning term' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Project source 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Source 2' })).toHaveAttribute('href', 'https://example.com/');
    expect(screen.getByRole('link', { name: 'Source 2' })).toHaveAttribute('target', '_blank');
    fireEvent.click(screen.getByRole('button', { name: 'View table fullscreen' }));
    expect(useChatTableStore.getState().target).toMatchObject({ nodeId: 'answer', turnId: 'turn', versionCreatedAt: 2, tableIndex: 0 });
    expect(screen.queryByText('Original question')).toBeNull();
    expect(container.querySelector('.chat-user-bubble, .chat-composer, .chat-message-actions')).toBeNull();
    const viewport = screen.getByRole('region', { name: 'Answer' });
    expect(fireEvent.wheel(viewport, { deltaY: 1200, cancelable: true })).toBe(true);
    expect(zoom).not.toHaveBeenCalled();
    fireEvent.wheel(viewport, { deltaY: 20, ctrlKey: true });
    fireEvent.wheel(screen.getByRole('region', { name: 'Scrollable table' }), { deltaY: -20, deltaX: 40, ctrlKey: true, shiftKey: true });
    expect(zoom).toHaveBeenCalledTimes(2);
  });
});
