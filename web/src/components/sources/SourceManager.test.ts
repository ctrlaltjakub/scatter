import { createElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import type { ProjectSource } from '@/store/types';
import { SourceManager, stageLabel } from './SourceManager';

describe('SourceManager deletion', () => {
  it.each([true, false])('confirms a pointer click in the separate dialog (embedded: %s)', async (embedded) => {
    const project = createBlankProject('Source deletion', 'root');
    const source: ProjectSource = {
      id: 'source', title: 'Ready source', kind: 'text', checked: true, createdAt: 1,
      contentHash: 'test', activeRevisionId: 'rev', revisions: {},
    };
    project.sourceLibrary = { mode: 'use', order: [source.id], sources: { [source.id]: source } };
    useGraphStore.setState({ project, activeProjectId: project.id });
    useSourceUiStore.getState().openManager();
    const user = userEvent.setup();
    render(createElement(SourceManager, { embedded }));
    const remove = () => user.click(screen.getByRole('button', { name: 'Delete Ready source' }));
    const confirmation = () => within(screen.getByRole('dialog', { name: 'Delete source?' }));
    await remove();
    await user.click(confirmation().getByRole('button', { name: 'No' }));
    expect(useGraphStore.getState().project?.sourceLibrary?.sources.source).toBeDefined();
    await remove();
    await user.click(confirmation().getByRole('button', { name: 'Yes' }));
    await vi.waitFor(() => expect(useGraphStore.getState().project?.sourceLibrary?.sources.source).toBeUndefined());
    expect(screen.queryByRole('dialog', { name: 'Delete source?' })).not.toBeInTheDocument();
  });
});

describe('SourceManager page counts', () => {
  beforeEach(() => {
    useSourceRuntimeStore.setState({ jobs: {}, embeddingStatus: 'idle' });
  });

  it.each([
    [1, 'PDF · 1 page · Ready'],
    [3, 'PDF · 3 pages · Ready'],
    [0, 'PDF · Ready'],
    [undefined, 'PDF · Ready'],
  ])('renders a source with pageCount %s as %s', (pageCount, label) => {
    const source: ProjectSource = {
      id: 'pdf', title: 'Reference.pdf', kind: 'pdf', checked: true,
      createdAt: 1, contentHash: 'test-hash', activeRevisionId: 'rev',
      revisions: { rev: {
        id: 'rev', createdAt: 1, status: 'ready', pageCount,
        contentAssetId: 'content', keywordIndexAssetId: 'keywords',
        index: { formatVersion: 1, embeddingModel: 'test', embeddingRevision: 'test', dimensions: 2 },
      } },
    };
    const project = createBlankProject('Page count test', 'root');
    project.sourceLibrary = { mode: 'use', order: [source.id], sources: { [source.id]: source } };
    useGraphStore.setState({ project, activeProjectId: project.id });
    render(createElement(SourceManager, { embedded: true }));

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('SourceManager stage labels', () => {
  it('shows passage-level semantic indexing progress', () => {
    expect(stageLabel({
      status: 'indexing',
      indexingCompleted: 16,
      indexingTotal: 43,
    })).toBe('Semantic indexing 16 / 43');
  });

  it('describes indexing before a passage total is available', () => {
    expect(stageLabel({ status: 'indexing' })).toBe('Preparing semantic index');
  });
});
