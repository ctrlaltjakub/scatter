import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ImageEditorBottomBar } from './ImageEditorBottomBar';
import { ImageFollowUpBar } from '@/components/node/ImageFollowUpBar';
import { useSettingsStore } from '@/store/useSettingsStore';
import { FOLLOW_UP_ROUTING_TOOLTIP } from '@/lib/followUpPlaceholder';
import { flushChatDrafts, useChatRuntimeStore } from '@/store/useChatRuntimeStore';

const base = { nodeId: 'image', capable: true, editable: true, checking: false, busy: false };
beforeEach(() => {
  flushChatDrafts(); localStorage.clear(); useChatRuntimeStore.setState({ drafts: {} });
  useSettingsStore.setState({ followUpEnterSends: true });
});

describe('shared image follow-up panel', () => {
  it('uses the identical implementation on the canvas and in the editor', () => {
    expect(ImageEditorBottomBar).toBe(ImageFollowUpBar);
  });

  it('keeps the original placeholder and puts routing guidance in the tooltip', () => {
    render(<ImageEditorBottomBar {...base} onAsk={vi.fn()} onModify={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Image follow-up question or modification' });
    expect(input).toHaveAttribute('placeholder', 'Ask a follow-up question or describe a modification…');
    expect(input).not.toHaveAttribute('title');
    expect(input).toHaveAttribute('data-tip', FOLLOW_UP_ROUTING_TOOLTIP);
    expect(input).toHaveAttribute('aria-description', FOLLOW_UP_ROUTING_TOOLTIP);
  });

  it('allows questions independently of the image-editing model', () => {
    render(<ImageEditorBottomBar {...base} capable={false} onAsk={vi.fn()} onModify={vi.fn()} />);
    const input = screen.getByRole('textbox');
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: 'What is this?' } });
    expect(screen.getByRole('button', { name: 'Ask follow-up' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Modify' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Modify' }).getAttribute('data-tip')).toMatch(/cannot edit/);
  });

  it('shows selected-part scope and submits trimmed instructions to the appropriate action', async () => {
    const ask = vi.fn(async () => undefined), modify = vi.fn(async () => undefined);
    render(<ImageEditorBottomBar {...base} selectedPart onAsk={ask} onModify={modify} />);
    expect(screen.getByLabelText('Targets selected part')).toHaveTextContent('whole image / selected part');
    expect(screen.getByText('selected part')).toHaveClass('is-active');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  What is this?  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => expect(ask).toHaveBeenCalledExactlyOnceWith('What is this?'));
    await vi.waitFor(() => expect(input).toHaveValue(''));
    fireEvent.change(input, { target: { value: '  Make it blue  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Modify' }));
    await vi.waitFor(() => expect(modify).toHaveBeenCalledExactlyOnceWith('Make it blue'));
  });

  it.each([{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }])('inserts a newline for %j', (modifiers) => {
    const ask = vi.fn();
    render(<ImageEditorBottomBar {...base} onAsk={ask} onModify={vi.fn()} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'beforeafter' } });
    input.setSelectionRange(6, 6);
    fireEvent.keyDown(input, { key: 'Enter', ...modifiers });
    expect(input).toHaveValue('before\nafter');
    expect(ask).not.toHaveBeenCalled();
  });

  it('honors the alternate Enter setting and ignores IME composition', async () => {
    useSettingsStore.setState({ followUpEnterSends: false });
    const ask = vi.fn(async () => undefined);
    render(<ImageEditorBottomBar {...base} onAsk={ask} onModify={vi.fn()} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '日本語' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ask).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
  });

  it('preserves the prompt and displays a preflight failure; blocks duplicate submissions', async () => {
    const modify = vi.fn(async () => { throw new Error('Image is unavailable'); });
    render(<ImageEditorBottomBar {...base} onAsk={vi.fn()} onModify={modify} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Make it blue' } });
    const button = screen.getByRole('button', { name: 'Modify' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Image is unavailable');
    expect(screen.getByRole('textbox')).toHaveValue('Make it blue');
    expect(modify).toHaveBeenCalledOnce();
  });

  it('clears Enter immediately while generation is still pending, without erasing a newer draft on completion', async () => {
    let finish!: () => void;
    const ask = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = render(<ImageEditorBottomBar {...base} selectedPart onAsk={ask} onModify={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Compare these areas' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(ask).toHaveBeenCalledWith('Compare these areas');
    expect(screen.getByRole('textbox')).toHaveValue('');
    view.unmount();
    render(<ImageEditorBottomBar {...base} selectedPart onAsk={ask} onModify={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My next question' } });
    await act(async () => finish());
    expect(screen.getByRole('textbox')).toHaveValue('My next question');
  });

  it('shares the draft between the node and editor and restores it after runtime reload', () => {
    const props = { ...base, onAsk: vi.fn(), onModify: vi.fn() };
    const node = render(<ImageFollowUpBar {...props} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pending image question 日本語 العربية' } });
    node.unmount();
    useChatRuntimeStore.setState({ drafts: {} });
    render(<ImageEditorBottomBar {...props} />);
    expect(screen.getByRole('textbox')).toHaveValue('Pending image question 日本語 العربية');
  });
});
