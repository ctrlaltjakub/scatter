import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { CanvasToolbar } from './CanvasToolbar';
import { useChatTableStore } from '@/store/useChatTableStore';

const state = vi.hoisted(() => ({
  project: true,
  textEditor: false,
  imageEditor: false,
  interactiveViewer: false,
}));

vi.mock('@/store/useGraphStore', () => ({
  useGraphStore: (selector: (s: { project: object | null }) => unknown) => selector({
    project: state.project ? {} : null,
  }),
}));
vi.mock('@/store/useEditorStore', () => ({
  useEditorStore: (selector: (s: { open: boolean }) => unknown) => selector({ open: state.textEditor }),
}));
vi.mock('@/store/useImageEditorStore', () => ({
  useImageEditorStore: (selector: (s: { open: boolean }) => unknown) => selector({ open: state.imageEditor }),
}));
vi.mock('@/store/useInteractiveViewerStore', () => ({
  useInteractiveViewerStore: (selector: (s: { open: boolean }) => unknown) => selector({
    open: state.interactiveViewer,
  }),
}));
vi.mock('@/components/NavActions', () => ({ NavActions: () => <div>navigation</div> }));
vi.mock('@/components/SidebarModelPicker', () => ({ SidebarModelPicker: () => <div>model picker</div> }));

describe('CanvasToolbar editor visibility', () => {
  beforeEach(() => {
    state.project = true;
    state.textEditor = false;
    state.imageEditor = false;
    state.interactiveViewer = false;
    useChatTableStore.getState().close();
  });

  it('shows on a collapsed ordinary canvas', () => {
    render(<CanvasToolbar containerRef={createRef()} sidebarCollapsed onOpenSettings={vi.fn()} />);
    expect(screen.getByText('navigation')).toBeInTheDocument();
  });

  it('stays hidden while a full-window editor or interactive viewer is open', () => {
    state.textEditor = true;
    const { rerender } = render(
      <CanvasToolbar containerRef={createRef()} sidebarCollapsed onOpenSettings={vi.fn()} />,
    );
    expect(screen.queryByText('navigation')).toBeNull();

    state.textEditor = false;
    state.imageEditor = true;
    rerender(<CanvasToolbar containerRef={createRef()} sidebarCollapsed onOpenSettings={vi.fn()} />);
    expect(screen.queryByText('navigation')).toBeNull();

    state.imageEditor = false;
    state.interactiveViewer = true;
    rerender(<CanvasToolbar containerRef={createRef()} sidebarCollapsed onOpenSettings={vi.fn()} />);
    expect(screen.queryByText('navigation')).toBeNull();
  });

  it('keeps the floating panel hidden in a fullscreen chat table', () => {
    useChatTableStore.getState().open({ nodeId: 'chat', turnId: 'turn', versionCreatedAt: 2, tableIndex: 0 });
    render(<CanvasToolbar containerRef={createRef()} sidebarCollapsed onOpenSettings={vi.fn()} />);
    expect(screen.queryByText('navigation')).toBeNull();
  });
});
