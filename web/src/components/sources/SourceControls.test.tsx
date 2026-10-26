import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import type { ProjectSource } from '@/store/types';
import { SourceControls } from './SourceControls';

function readySource(id = 'source-1'): ProjectSource {
  const revisionId = `${id}-revision`;
  return {
    id,
    title: 'A useful source',
    kind: 'text',
    checked: true,
    createdAt: 1,
    contentHash: `${id}-hash`,
    activeRevisionId: revisionId,
    revisions: {
      [revisionId]: {
        id: revisionId,
        createdAt: 1,
        status: 'ready',
        contentAssetId: `${id}-content`,
        keywordIndexAssetId: `${id}-keyword`,
        index: {
          formatVersion: 1,
          embeddingModel: 'test-model',
          embeddingRevision: 'test',
          dimensions: 2,
        },
      },
    },
  };
}

beforeEach(() => {
  const project = createBlankProject('Sources test', 'root');
  useGraphStore.setState({ project, activeProjectId: project.id });
  useSourceUiStore.setState({ managerOpen: false, importOpen: false, viewer: null, topicDraft: null });
  useSourceRuntimeStore.setState({ jobs: {}, embeddingStatus: 'idle', embeddingProgress: 0, embeddingError: undefined });
});

describe('SourceControls', () => {
  it('shows the effective Ignore state and opens import when the project is empty', async () => {
    const user = userEvent.setup();
    render(<SourceControls />);

    expect(screen.getByRole('button', { name: 'Ignore sources' })).toBeDisabled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add sources/i }));
    expect(useSourceUiStore.getState().importOpen).toBe(true);
  });

  it('changes the persistent mode and opens the manager for ready sources', async () => {
    const project = useGraphStore.getState().project!;
    const source = readySource();
    useGraphStore.setState({
      project: {
        ...project,
        sourceLibrary: { mode: 'use', rememberedNonIgnoreMode: 'use', order: [source.id], sources: { [source.id]: source } },
      },
    });
    const user = userEvent.setup();
    render(<SourceControls />);

    const trigger = screen.getByRole('button', { name: 'Use sources' });
    expect(trigger).not.toHaveClass('active');
    await user.click(trigger);
    expect(trigger).not.toHaveClass('active');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Use sources' })).toBeChecked();
    await user.click(screen.getByRole('menuitemradio', { name: 'Limit to sources' }));
    expect(useGraphStore.getState().project?.sourceLibrary?.mode).toBe('only');
    await user.click(screen.getByRole('button', { name: /sources 1\/1/i }));
    expect(useSourceUiStore.getState().managerOpen).toBe(true);
    await user.click(screen.getByRole('button', { name: /sources 1\/1/i }));
    expect(useSourceUiStore.getState().managerOpen).toBe(false);
  });

  it('toggles the embedded manager instead of the import window when requested', async () => {
    const user = userEvent.setup();
    render(<SourceControls emptyAction="manager" />);

    const button = screen.getByRole('button', { name: /add sources/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(useSourceUiStore.getState().managerOpen).toBe(true);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.click(button);
    expect(useSourceUiStore.getState().managerOpen).toBe(false);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(useSourceUiStore.getState().importOpen).toBe(false);
  });

  it('presents an empty source state while a new project is still uncommitted', async () => {
    const project = useGraphStore.getState().project!;
    const source = readySource();
    useGraphStore.setState({
      project: {
        ...project,
        sourceLibrary: { mode: 'only', rememberedNonIgnoreMode: 'only', order: [source.id], sources: { [source.id]: source } },
      },
    });
    const user = userEvent.setup();
    render(<SourceControls emptyAction="manager" virtualEmpty />);

    expect(screen.getByRole('button', { name: 'Ignore sources' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add sources' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add sources' }));
    expect(useSourceUiStore.getState().managerOpen).toBe(true);
    expect(useGraphStore.getState().project?.sourceLibrary?.mode).toBe('only');
    await user.click(screen.getByRole('button', { name: 'Add sources' }));
    expect(useSourceUiStore.getState().managerOpen).toBe(false);
    expect(useGraphStore.getState().project?.sourceLibrary?.mode).toBe('only');
  });

  it('renders the restoration-shell version without focusable controls', () => {
    const { container } = render(<SourceControls disabled inert />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(screen.getByText('Add sources')).toBeInTheDocument();
  });
});
