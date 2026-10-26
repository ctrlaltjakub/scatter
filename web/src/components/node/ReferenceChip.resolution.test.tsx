import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Arrow, ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useReferenceResolution } from './ReferenceChip';

afterEach(() => {
  cleanup();
  useGraphStore.getState().setProject(null);
  useGraphStore.temporal.getState().resume();
});

function node(id: string): ScatterNode {
  return {
    id,
    type: id === 'p1' ? 'root' : 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{ header: id, body: 'Body', createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

function arrow(id: string, fromNodeId: string, toNodeId: string, label: string): Arrow {
  return {
    id,
    kind: 'auto',
    fromNodeId,
    toNodeId,
    label,
  };
}

function seedProject(): void {
  const proj = createBlankProject('reference resolution', 'p1');
  useGraphStore.getState().setProject({
    ...proj,
    selection: [],
    nodes: {
      p1: node('p1'),
      c1: node('c1'),
      other: node('other'),
    },
    arrows: {
      a1: arrow('a1', 'p1', 'c1', 'therapy'),
      a2: arrow('a2', 'other', 'p1', 'unrelated'),
    },
  });
  useGraphStore.temporal.getState().pause();
}

function ResolutionProbe() {
  const resolution = useReferenceResolution('p1');
  return (
    <div
      data-testid="probe"
      data-child={resolution.childByTerm.get('therapy') ?? ''}
      data-selected={resolution.selectedNodeId ?? ''}
      data-highlighted={resolution.highlightedTerm ?? ''}
    />
  );
}

describe('ReferenceChip shared resolution', () => {
  it('ignores unrelated focus and multi-selection but updates its own child highlight', () => {
    seedProject();
    let commits = 0;
    render(<Profiler id="resolution" onRender={() => { commits++; }}><ResolutionProbe /></Profiler>);
    commits = 0;

    act(() => useGraphStore.getState().setSelection(['other']));
    act(() => useGraphStore.getState().setSelection(['other', 'p1']));
    act(() => useGraphStore.getState().setSelection(['other', 'p1', 'c1']));
    expect(commits).toBe(0);

    act(() => useGraphStore.getState().setSelection(['c1']));
    expect(commits).toBe(1);
    expect(screen.getByTestId('probe')).toHaveAttribute('data-selected', 'c1');
    act(() => useGraphStore.getState().setSelection(['c1', 'other']));
    expect(commits).toBe(2);
    expect(screen.getByTestId('probe')).toHaveAttribute('data-selected', '');
    act(() => useGraphStore.getState().setSelection(['c1', 'other', 'p1']));
    expect(commits).toBe(2);
  });

  it('does not re-render on unrelated project updates', () => {
    seedProject();
    let commits = 0;
    const onRender: ProfilerOnRenderCallback = () => {
      commits++;
    };
    render(
      <Profiler id="resolution" onRender={onRender}>
        <ResolutionProbe />
      </Profiler>,
    );
    commits = 0;

    act(() => {
      useGraphStore.getState().updateNode('other', { bulletsCollapsed: true });
    });

    expect(commits).toBe(0);
  });

  it('refreshes explored targets across undo/redo and project switches without adding history for focus', () => {
    seedProject();
    const temporal = useGraphStore.temporal.getState();
    temporal.clear(); temporal.resume();
    render(<ResolutionProbe />);
    act(() => useGraphStore.getState().setSelection(['c1']));
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    act(() => useGraphStore.getState().addArrow(arrow('a1', 'p1', 'other', 'therapy')));
    expect(screen.getByTestId('probe')).toHaveAttribute('data-child', 'other');
    expect(screen.getByTestId('probe')).toHaveAttribute('data-selected', '');
    act(() => useGraphStore.temporal.getState().undo());
    expect(screen.getByTestId('probe')).toHaveAttribute('data-child', 'c1');
    expect(screen.getByTestId('probe')).toHaveAttribute('data-selected', 'c1');
    act(() => useGraphStore.temporal.getState().redo());
    expect(screen.getByTestId('probe')).toHaveAttribute('data-child', 'other');

    const project = useGraphStore.getState().project!;
    act(() => useGraphStore.getState().setProject({ ...project, id: 'different-project', arrows: {} }));
    expect(screen.getByTestId('probe')).toHaveAttribute('data-child', '');
    expect(screen.getByTestId('probe')).toHaveAttribute('data-selected', '');
  });

  it('keeps transient term flashes scoped to the exact chat answer', () => {
    seedProject();
    const old = { turnId: 'turn', versionCreatedAt: 2 };
    const next = { turnId: 'turn', versionCreatedAt: 3 };
    act(() => useGraphStore.getState().addArrow({ ...arrow('chat', 'p1', 'c1', 'therapy'), sourceAnswer: old }));
    function AnswerProbe() {
      const resolution = useReferenceResolution('p1', old);
      return <div data-testid="answer" data-highlight={resolution.highlightedTerm ?? ''} />;
    }
    let commits = 0;
    render(<Profiler id="answer" onRender={() => { commits++; }}><AnswerProbe /></Profiler>);
    commits = 0;
    act(() => {
      useGraphStore.getState().addArrow({ ...arrow('other-answer', 'p1', 'c1', 'therapy'), sourceAnswer: next });
      useGraphStore.setState({ highlight: { parentNodeId: 'p1', childNodeId: 'c1', arrowId: 'other-answer', term: 'therapy', nonce: 1 } });
    });
    expect(screen.getByTestId('answer')).toHaveAttribute('data-highlight', '');
    expect(commits).toBe(0);
    act(() => useGraphStore.setState({ highlight: { parentNodeId: 'p1', childNodeId: 'c1', arrowId: 'chat', term: 'therapy', nonce: 2 } }));
    expect(screen.getByTestId('answer')).toHaveAttribute('data-highlight', 'therapy');
    act(() => useGraphStore.getState().clearHighlight());
    expect(screen.getByTestId('answer')).toHaveAttribute('data-highlight', '');
  });
});
