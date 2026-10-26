import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { SOURCE_VIEWER_READING_ID } from '@/lib/readingController';
import type { NormalizedSourceDocument, ProjectSource } from '@/store/types';
import SourceViewerOverlay from './SourceViewerOverlay';

const loadSourceAsset = vi.hoisted(() => vi.fn());
const decodeSourceDocument = vi.hoisted(() => vi.fn());
vi.mock('@/opfs/sourceAssetsIO', () => ({ loadSourceAsset }));
vi.mock('@/lib/sourceCodec', () => ({ decodeSourceDocument }));

const documentFixture: NormalizedSourceDocument = {
  schemaVersion: 1,
  revisionId: 'revision-1',
  title: 'Therapy notes',
  blocks: [
    { id: 'page-1', page: 1, section: 'Beginning', text: 'First evidence passage.' },
    { id: 'page-2', page: 2, text: 'Second evidence passage.' },
  ],
  chunks: [
    { id: 'chunk-1', blockId: 'page-1', text: 'First evidence passage.', page: 1, start: 0, end: 23 },
    { id: 'chunk-2', blockId: 'page-2', text: 'Second evidence passage.', page: 2, start: 0, end: 24 },
  ],
};

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const project = createBlankProject('Viewer test', 'root');
  const source: ProjectSource = {
    id: 'source-1', title: 'Therapy notes', kind: 'text', checked: true,
    createdAt: 1, contentHash: 'hash', activeRevisionId: 'revision-1',
    revisions: {
      'revision-1': {
        id: 'revision-1', createdAt: 1, status: 'ready', pageCount: 2,
        contentAssetId: 'content', keywordIndexAssetId: 'keyword',
        index: { formatVersion: 1, embeddingModel: 'test', embeddingRevision: 'test', dimensions: 2 },
      },
    },
  };
  useGraphStore.setState({
    project: {
      ...project,
      sourceLibrary: { mode: 'use', order: [source.id], sources: { [source.id]: source } },
    },
    activeProjectId: project.id,
  });
  useSourceUiStore.setState({
    managerOpen: false,
    importOpen: false,
    topicDraft: null,
    viewer: { projectId: project.id, sourceId: source.id, revisionId: 'revision-1', passageId: 'chunk-2' },
  });
  loadSourceAsset.mockReset().mockResolvedValue(new Blob(['encoded']));
  decodeSourceDocument.mockReset().mockResolvedValue(documentFixture);
});

describe('SourceViewerOverlay', () => {
  it('opens the cited page and exposes a standalone reading-ruler surface', async () => {
    const { container } = render(<SourceViewerOverlay />);
    await screen.findByText('Second evidence passage.');

    const viewer = container.querySelector<HTMLElement>('[data-sc-reading-standalone]');
    expect(viewer).toHaveAttribute('data-sc-reading-node-id', SOURCE_VIEWER_READING_ID);
    expect(screen.getAllByText('Page 2')).toHaveLength(2);
    expect(screen.queryByText('First evidence passage.')).not.toBeInTheDocument();
  });

  it('searches the visible source and closes with Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(<SourceViewerOverlay />);
    await screen.findByText('Second evidence passage.');
    await user.type(screen.getByPlaceholderText('Search this source…'), 'evidence');
    expect(container.querySelector('mark')).toHaveTextContent('evidence');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(useSourceUiStore.getState().viewer).toBeNull());
  });
});
