import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFollowUpBar } from './NodeFollowUpBar';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { FOLLOW_UP_ROUTING_TOOLTIP } from '@/lib/followUpPlaceholder';
import { AppTooltips } from '@/components/AppTooltips';
import { NODE_BOTTOM_PANEL_GAP } from '@/lib/fitBBox';
import { flushChatDrafts, useChatRuntimeStore } from '@/store/useChatRuntimeStore';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', '..', 'app', 'globals.css'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[1]!;
}

const generation = vi.hoisted(() => ({
  spawnFollowUp: vi.fn(),
  modifyNode: vi.fn(),
  modifySelection: vi.fn(),
  generateEmptyTextNode: vi.fn(),
}));

vi.mock('@/lib/generate', () => generation);

const exact = {
  nodeId: 'n1', versionIndex: 0, sourceBody: 'alpha beta',
  start: 6, end: 10, text: 'beta',
};

describe('NodeFollowUpBar selection scope', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    flushChatDrafts(); localStorage.clear(); useChatRuntimeStore.setState({ drafts: {} });
    generation.spawnFollowUp.mockReset();
    generation.modifyNode.mockReset();
    generation.modifySelection.mockReset();
    generation.generateEmptyTextNode.mockReset();
    useGraphStore.setState({ project: null });
    useNodeTextSelectionStore.getState().clear();
    useSettingsStore.setState({ followUpEnterSends: true });
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each(['encyclopedic', 'explain'] as const)('gives a blank %s card one contextual generation action', type => {
    const project = createBlankProject('Example', 'n1');
    project.nodes.n1 = { id: 'n1', type: 'manual-empty', position: { x: 0, y: 0 }, frozen: false,
      currentVersionIndex: 0, versions: [{ header: 'New node', body: '', contentType: type,
        emptyText: true, generatedBy: 'manual', createdAt: 1 }] };
    useGraphStore.setState({ project });
    render(<NodeFollowUpBar nodeId="n1" />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByLabelText('Targets whole node')).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText(type === 'explain' ? 'What would you like explained?' : 'What would you like to explore?');
    expect(input).not.toHaveAttribute('data-tip');
    fireEvent.change(input, { target: { value: 'Gravity' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(generation.generateEmptyTextNode).toHaveBeenCalledWith('n1', 'Gravity');
    expect(generation.spawnFollowUp).not.toHaveBeenCalled();
  });

  it('shows one shared whole-node scope below both actions', () => {
    render(<NodeFollowUpBar nodeId="n1" />);
    const scope = screen.getByLabelText('Targets whole node');
    expect(scope).toHaveTextContent('whole node / selected text');
    expect(screen.getAllByText('whole node')).toHaveLength(1);
    expect(screen.getAllByText('selected text')).toHaveLength(1);
    expect(screen.getByText('whole node')).toHaveClass('is-active');
    expect(screen.getByText('selected text')).not.toHaveClass('is-active');
    expect(scope.closest('button')).toBeNull();
  });

  it('keeps the original placeholder and shows routing guidance in the hover tooltip', async () => {
    render(<><NodeFollowUpBar nodeId="n1" /><AppTooltips /></>);
    const input = screen.getByRole('textbox', { name: 'Follow-up question or modification' });
    expect(input).toHaveAttribute('placeholder', 'Ask a follow-up question or describe a modification…');
    expect(input).not.toHaveAttribute('title');
    expect(input).toHaveAttribute('data-tip', FOLLOW_UP_ROUTING_TOOLTIP);
    expect(input).toHaveAttribute('aria-description', FOLLOW_UP_ROUTING_TOOLTIP);
    fireEvent.mouseOver(input);
    expect(await screen.findByText(FOLLOW_UP_ROUTING_TOOLTIP)).toBeVisible();
  });

  it('keeps bottom-panel spacing and camera-fit geometry consistent', () => {
    expect(css).toContain(`--node-bottom-gap: ${NODE_BOTTOM_PANEL_GAP}px;`);
    expect(ruleBody('.node-followup-bar')).toContain('top: calc(100% + var(--node-bottom-gap))');
    expect(ruleBody('.text-editor-bottom')).toContain('top: calc(100% + var(--node-bottom-gap))');
    expect(ruleBody('.image-editor-cardwrap > .image-followup-bar')).toContain('margin-top: var(--node-bottom-gap)');
  });

  it('lets the shared scope text define both button widths', () => {
    expect(ruleBody('.node-followup-actions')).toMatch(/width:\s*max-content\s*;/);
    expect(ruleBody('.node-followup-scope')).toMatch(/white-space:\s*nowrap\s*;/);
  });

  it('routes ask and modify to the selected text and clears it after submission', () => {
    act(() => useNodeTextSelectionStore.getState().set(exact));
    const { rerender } = render(<NodeFollowUpBar nodeId="n1" />);
    expect(screen.getByText('selected text')).toHaveClass('is-active');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Please clarify' } });
    fireEvent.click(screen.getByRole('button', { name: /Ask follow-up/ }));
    expect(generation.spawnFollowUp).toHaveBeenCalledWith('n1', 'Please clarify', exact);
    expect(useNodeTextSelectionStore.getState().selection).toBeNull();

    act(() => useNodeTextSelectionStore.getState().set(exact));
    rerender(<NodeFollowUpBar nodeId="n1" />);
    fireEvent.change(input, { target: { value: 'Make it exact' } });
    fireEvent.click(screen.getByRole('button', { name: /Modify/ }));
    expect(generation.modifySelection).toHaveBeenCalledWith(exact, 'Make it exact');
    expect(generation.modifyNode).not.toHaveBeenCalled();
  });

  it('uses Shift+Enter as a newline instead of the old Modify shortcut', () => {
    render(<NodeFollowUpBar nodeId="n1" />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'beforeafter' } });
    input.setSelectionRange(6, 6);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(input).toHaveValue('before\nafter');
    expect(generation.modifyNode).not.toHaveBeenCalled();
    expect(generation.modifySelection).not.toHaveBeenCalled();
  });
});
