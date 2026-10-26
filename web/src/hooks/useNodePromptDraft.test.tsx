import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useNodePromptDraft } from './useNodePromptDraft';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { chatDraftKey, flushChatDrafts, useChatRuntimeStore } from '@/store/useChatRuntimeStore';

function Prompt({ id }: { id: string }) {
  const { text, setText } = useNodePromptDraft(id);
  return <textarea aria-label="Draft" value={text} onChange={event => setText(event.target.value)} />;
}
beforeEach(() => {
  flushChatDrafts(); localStorage.clear(); useChatRuntimeStore.setState({ drafts: {} });
  useGraphStore.setState({ project: { ...createBlankProject('Drafts', 'root'), id: 'p1' } });
});
describe('node prompt drafts', () => {
  it('persists across focus/unmount/restart without changing project content or undo history', () => {
    const project = useGraphStore.getState().project;
    const history = useGraphStore.temporal.getState().pastStates.length;
    const view = render(<Prompt id="a" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '日本語。 العربية؟\nहिन्दी।' } });
    view.unmount();
    expect(JSON.parse(localStorage.getItem(chatDraftKey('p1', 'a'))!)).toEqual({ text: '日本語。 العربية؟\nहिन्दी।' });
    useChatRuntimeStore.setState({ drafts: {} });
    render(<Prompt id="a" />);
    expect(screen.getByRole('textbox')).toHaveValue('日本語。 العربية؟\nहिन्दी।');
    expect(useGraphStore.getState().project).toBe(project);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(history);
  });
  it('keeps drafts separate for different nodes and projects, and clears stored submissions', () => {
    const view = render(<Prompt id="a" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Project 1, node A' } });
    view.rerender(<Prompt id="b" />);
    expect(screen.getByRole('textbox')).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Project 1, node B' } });
    view.rerender(<Prompt id="a" />);
    expect(screen.getByRole('textbox')).toHaveValue('Project 1, node A');
    act(() => useGraphStore.setState({ project: { ...useGraphStore.getState().project!, id: 'p2' } }));
    expect(screen.getByRole('textbox')).toHaveValue('');
    act(() => useGraphStore.setState({ project: { ...useGraphStore.getState().project!, id: 'p1' } }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    flushChatDrafts();
    expect(localStorage.getItem(chatDraftKey('p1', 'a'))).toBeNull();
    expect(localStorage.getItem(chatDraftKey('p1', 'b'))).toContain('Project 1, node B');
  });
});
