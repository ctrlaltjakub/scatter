import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';
import { buildInteractiveNode } from '@/lib/interactiveActions';
import { InteractiveNodeBody } from './InteractiveNodeBody';

vi.mock('@/lib/interactiveActions', () => ({ buildInteractiveNode: vi.fn() }));
vi.mock('./InteractiveExplanationView', () => ({ InteractiveExplanationView: () => <div data-testid="program" /> }));
const html = '<!doctype html><html><body><button>Add one</button></body></html>';
function fixture(): ScatterNode {
  return { id: 'draft', type: 'interactive', position: { x: 0, y: 0 }, frozen: true, currentVersionIndex: 0,
    versions: [{ header: 'Counter', body: 'Counter', createdAt: 1, generatedBy: 'interactive', contentType: 'interactive', interactiveStandalone: true,
      interactiveBuild: { request: 'Counter', state: 'failed', steps: [], draftHtml: html,
        repairPasses: 5, limitReached: true, error: 'The counter does not update' } }] };
}
beforeEach(() => {
  vi.clearAllMocks();
  useInteractiveViewerStore.getState().close();
});

describe('interactive draft recovery choices', () => {
  it('renders a quiet info line and a paused status without a spinning progress icon', () => {
    const node = fixture(); node.generating = true; node.generatingVersionIndex = 0;
    node.versions[0]!.interactiveBuild!.steps = [
      { id: 0, kind: 'info', state: 'complete', label: 'Keep this tab visible during interactive generation.' },
      { id: 1, kind: 'paused', state: 'running', label: 'Verification paused — return to this tab to continue.' },
    ];
    const { container } = render(<InteractiveNodeBody node={node} active />);
    expect(screen.getByRole('log').firstElementChild).toHaveTextContent('Keep this tab visible');
    expect(container.querySelector('.is-info .lucide-info')).not.toBeNull();
    expect(container.querySelector('.is-paused .lucide-pause')).not.toBeNull();
    expect(container.querySelector('.is-running')).toBeNull();
  });
  it('follows progress only while the user remains at the bottom', () => {
    const node = fixture(); node.generating = true; node.generatingVersionIndex = 0;
    const { rerender } = render(<InteractiveNodeBody node={node} active />);
    const log = screen.getByRole('log');
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 300 } });
    log.scrollTop = 100; fireEvent.scroll(log);
    const progress = () => ({ ...node, versions: [{ ...node.versions[0]!, interactiveBuild: { ...node.versions[0]!.interactiveBuild!, steps: [] } }] });
    rerender(<InteractiveNodeBody node={progress()} active />);
    expect(log.scrollTop).toBe(100);
    log.scrollTop = 700; fireEvent.scroll(log);
    Object.defineProperty(log, 'scrollHeight', { value: 1100 });
    rerender(<InteractiveNodeBody node={progress()} active />);
    expect(log.scrollTop).toBe(1100);
  });
  it('offers all three actions and opens a transient, unverified preview without generating', () => {
    const node = fixture();
    render(<InteractiveNodeBody node={node} active />);
    expect(screen.getByRole('button', { name: 'Run one more pass' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start over' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'View anyway' }));
    expect(useInteractiveViewerStore.getState()).toMatchObject({ open: true, nodeId: node.id, versionIndex: 0, draftCreatedAt: 1 });
    expect(buildInteractiveNode).not.toHaveBeenCalled();
    expect(node.versions[0]?.interactive).toBeUndefined();
    expect(node.versions[0]?.interactiveBuild?.state).toBe('failed');
    // The canvas retains its recovery choices while the enlarged preview is open.
    expect(screen.queryByTestId('program')).not.toBeInTheDocument();
  });
  it('separates continuation from starting over', () => {
    const node = fixture();
    render(<InteractiveNodeBody node={node} active />);
    fireEvent.click(screen.getByRole('button', { name: 'Run one more pass' }));
    expect(buildInteractiveNode).toHaveBeenLastCalledWith(node.id, undefined, 'repair');
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(buildInteractiveNode).toHaveBeenLastCalledWith(node.id);
  });
  it('only displays a preview for the exact saved version requested', () => {
    const node = fixture();
    useInteractiveViewerStore.getState().openViewer(node.id, 0, 1);
    const { rerender } = render(<InteractiveNodeBody node={node} active presentation="viewer" />);
    expect(screen.getByTestId('program')).toBeInTheDocument();
    const other = { ...node, versions: [{ ...node.versions[0]!, createdAt: 2 }] };
    rerender(<InteractiveNodeBody node={other} active presentation="viewer" />);
    expect(screen.queryByTestId('program')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View anyway' })).toBeVisible();
  });
  it.each(['<!doctype html><html><body>Incomplete', html.replace('Add one', '<script>fetch("/")</script>')])(
    'never bypasses static safety or completeness validation for a preview', draftHtml => {
      const node = fixture(); node.versions[0]!.interactiveBuild!.draftHtml = draftHtml;
      render(<InteractiveNodeBody node={node} active />);
      expect(screen.getByRole('button', { name: 'View anyway' })).toBeDisabled();
      expect(screen.getByText(/Preview unavailable/)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Run one more pass' })).toBeEnabled();
    });
  it('does not offer recovery while a build is still running', () => {
    const node = fixture(); node.generating = true; node.generatingVersionIndex = 0;
    node.versions[0]!.interactiveBuild!.model = 'moonshotai/kimi-k3.1-pro';
    render(<InteractiveNodeBody node={node} active />);
    expect(screen.getByText('Generating an interactive node with kimi k3.1 pro')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('shows a provider failure that prevents an extra pass from starting', () => {
    const node = fixture(); node.generationError = 'Choose a model with vision support.';
    render(<InteractiveNodeBody node={node} active />);
    expect(screen.getByRole('alert')).toHaveTextContent(node.generationError);
  });
});
