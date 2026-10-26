import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { CitationMarker, citationUrl } from './CitationMarker';
import { NodeContentInteractionProvider } from './NodeContentInteractionContext';

beforeEach(() => {
  vi.useFakeTimers();
  const project = createBlankProject('Citations', 'n');
  useGraphStore.getState().setProject({ ...project, nodes: { n: {
    id: 'n', type: 'root', position: { x: 0, y: 0 }, frozen: true, currentVersionIndex: 1,
    versions: [
      { header: 'Old', body: 'Old citation', createdAt: 1, generatedBy: 'root', sources: [
        { n: 1, url: 'https://old.example/first', domain: 'old.example', title: 'Older source' },
      ] },
      { header: 'New', body: 'New citation', createdAt: 2, generatedBy: 'root', sources: [
        { n: 1, url: 'https://www.example.org/current', title: 'Current source' },
        { n: 3, url: 'javascript:alert(1)', title: 'Unsafe source' },
      ], internalSources: [{ n: 2, sourceId: 's', revisionId: 'r', passageId: 'p4',
        sourceTitle: 'Project manual', page: 4, excerpt: 'Original passage.' }] },
    ],
  } } });
  useSourceUiStore.setState({ viewer: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); useGraphStore.getState().setProject(null); });

describe('direct citation sources', () => {
  it('opens a native safe new-tab link without focusing the node or opening a panel', () => {
    render(<CitationMarker n={1} parentNodeId="n" />);
    expect(screen.getByRole('link', { name: 'Source 1' })).toHaveAttribute('href', 'https://www.example.org/current');
    expect(screen.getByRole('link')).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
    expect(useGraphStore.getState().project?.selection).toEqual([]);
    expect(useGraphStore.getState().panTo).toBeNull();
  });
  it('shows the domain after hovering and clears it after leaving, scrolling, or resizing', () => {
    render(<CitationMarker n={1} parentNodeId="n" />);
    const link = screen.getByRole('link');
    fireEvent.mouseEnter(link);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveTextContent('example.org');
    fireEvent.mouseLeave(link);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(link);
    fireEvent.wheel(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(link);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('cancels a pending preview on blur instead of flashing it later', () => {
    render(<CitationMarker n={1} parentNodeId="n" />);
    const link = screen.getByRole('link');
    fireEvent.mouseEnter(link); fireEvent.focus(link); fireEvent.blur(link);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('uses the displayed historical answer sources rather than the currently selected answer', () => {
    render(<NodeContentInteractionProvider value={{ citationVersionCreatedAt: 1 }}>
      <CitationMarker n={1} parentNodeId="n" />
    </NodeContentInteractionProvider>);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://old.example/first');
  });
  it('supports explicit source lists, including empty lists without falling back to another answer', () => {
    const { rerender } = render(<NodeContentInteractionProvider value={{ citationSources: [
      { n: 1, url: 'https://answer.example/source', title: 'Answer source' },
    ] }}><CitationMarker n={1} parentNodeId="n" /></NodeContentInteractionProvider>);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://answer.example/source');
    rerender(<NodeContentInteractionProvider value={{ citationSources: [] }}>
      <CitationMarker n={1} parentNodeId="n" />
    </NodeContentInteractionProvider>);
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('retains exact passage navigation for imported sources', () => {
    render(<CitationMarker n={2} internal parentNodeId="n" />);
    fireEvent.focus(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Project manual · Page 4');
    fireEvent.click(screen.getByRole('button'));
    expect(useSourceUiStore.getState().viewer).toMatchObject({ sourceId: 's', revisionId: 'r', passageId: 'p4', nodeId: 'n' });
  });
  it('does not pass citation activation to a surrounding title-term button', () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><CitationMarker n={1} parentNodeId="n" /></div>);
    fireEvent.keyDown(screen.getByRole('link'), { key: 'Enter' });
    expect(outer).not.toHaveBeenCalled();
  });
  it('keeps missing and unsafe URLs non-clickable', () => {
    render(<><CitationMarker n={3} parentNodeId="n" /><CitationMarker n={99} parentNodeId="n" /></>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(citationUrl('data:text/html,test')).toBeNull();
    expect(citationUrl('https://valid.example/')).toBe('https://valid.example/');
  });
});
