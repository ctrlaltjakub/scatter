import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { ProjectMeta, ScatterNode } from '@/store/types';
import { Sidebar } from './Sidebar';

const switching = vi.hoisted(() => {
  let resolve: (() => void) | null = null;
  let reject: ((error: Error) => void) | null = null;
  return {
    run: vi.fn((_id: string) => new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    })),
    resolve: () => resolve?.(),
    reject: (error: Error) => reject?.(error),
    reset: () => {
      resolve = null;
      reject = null;
    },
  };
});

vi.mock('@/store/projectActions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/store/projectActions')>(),
  switchScatter: (id: string) => switching.run(id),
}));
vi.mock('./NavActions', () => ({ NavActions: () => null }));
vi.mock('./SidebarModelPicker', () => ({ SidebarModelPicker: () => null }));
vi.mock('@/components/canvas/Minimap', () => ({ Minimap: () => null }));

const root: ScatterNode = {
  id: 'root', type: 'root', position: { x: 0, y: 0 }, frozen: true,
  versions: [{ header: 'Root', body: 'Root body.', createdAt: 0, generatedBy: 'root' }],
  currentVersionIndex: 0,
};

function meta(id: string, name: string): ProjectMeta {
  return { id, name, createdAt: 0, updatedAt: 0, color: '#789abc' };
}

describe('Sidebar project-switch loading feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    switching.run.mockClear();
    switching.reset();
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }));
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const project = createBlankProject('Current project', root.id);
    useGraphStore.setState({
      project: { ...project, nodes: { root } },
      activeProjectId: project.id,
      projectList: [
        meta(project.id, project.name),
        meta('slow', 'Slow project'),
        meta('other', 'Other project'),
      ],
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    useGraphStore.getState().setProject(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('paints the loading layer before starting expensive project work', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const row = screen.getByText('Slow project').closest('.sidebar-row')!;

    fireEvent.click(row);

    expect(row).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('Opening Slow project')).toBeInTheDocument();
    expect(switching.run).not.toHaveBeenCalled();

    act(() => { frames.shift()?.(0); });
    expect(switching.run).not.toHaveBeenCalled();

    await act(async () => { frames.shift()?.(16); });
    expect(switching.run).toHaveBeenCalledWith('slow');
  });

  it('mounts a visually delayed spinner layer as soon as switching starts', async () => {
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const row = screen.getByText('Slow project').closest('.sidebar-row')!;

    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-busy', 'true');
    const spinner = screen.getByLabelText('Opening Slow project');
    expect(spinner).toHaveClass('project-switch-spinner');
    expect(spinner.tagName).toBe('SPAN');
    expect(spinner.querySelector('svg')).not.toBeNull();

    await act(async () => {});
    expect(switching.run).toHaveBeenCalledWith('slow');
  });

  it('blocks concurrent project-row interactions and clears loading after success', async () => {
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const slowRow = screen.getByText('Slow project').closest('.sidebar-row')!;
    const otherRow = screen.getByText('Other project').closest('.sidebar-row')!;

    fireEvent.click(slowRow);
    fireEvent.click(otherRow);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Slow project' }));

    await act(async () => {});
    expect(switching.run).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Edit Slow project' })).toBeDisabled();

    await act(async () => { switching.resolve(); });

    expect(slowRow).not.toHaveAttribute('aria-busy');
    expect(screen.queryByLabelText('Opening Slow project')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Slow project' })).not.toBeDisabled();
  });

  it('keeps delayed feedback working through React strict-mode effect checks', async () => {
    render(
      <StrictMode>
        <Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />
      </StrictMode>,
    );

    fireEvent.click(screen.getByText('Slow project').closest('.sidebar-row')!);

    expect(screen.getByLabelText('Opening Slow project')).toBeInTheDocument();
    await act(async () => {});
    expect(switching.run).toHaveBeenCalledWith('slow');
  });

  it('clears loading feedback when opening the project fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const row = screen.getByText('Slow project').closest('.sidebar-row')!;
    fireEvent.click(row);
    expect(screen.getByLabelText('Opening Slow project')).toBeInTheDocument();
    await act(async () => {});

    await act(async () => { switching.reject(new Error('disk unavailable')); });

    expect(row).not.toHaveAttribute('aria-busy');
    expect(screen.queryByLabelText('Opening Slow project')).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      '[scatter] project switch failed:',
      expect.any(Error),
    );
  });
});
