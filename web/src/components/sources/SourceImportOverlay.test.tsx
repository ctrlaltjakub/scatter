import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { pickGoogleDriveSourceFiles } from '@/lib/googleDriveSourcePicker';
import { createScatter } from '@/store/projectActions';
import { addPastedSource, addSourceFiles } from '@/lib/sourceProcessing';
import { SourceImportOverlay } from './SourceImportOverlay';

vi.mock('@/lib/googleDriveSourcePicker', () => ({
  pickGoogleDriveSourceFiles: vi.fn(),
}));
vi.mock('@/store/projectActions', () => ({
  createScatter: vi.fn(),
}));
vi.mock('@/lib/sourceProcessing', () => ({
  addPastedSource: vi.fn(),
  addSourceFiles: vi.fn(),
  addWebpageSources: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(pickGoogleDriveSourceFiles).mockReset();
  vi.mocked(createScatter).mockReset();
  vi.mocked(addPastedSource).mockReset();
  const project = createBlankProject('Import test', 'root');
  useGraphStore.setState({ project, activeProjectId: project.id, pickerOpen: false });
  useSourceUiStore.setState({ managerOpen: false, importOpen: true, viewer: null, topicDraft: null });
});

describe('SourceImportOverlay', () => {
  it('reuses file input for message attachments without creating project sources', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {}), onClose = vi.fn();
    const { container } = render(<SourceImportOverlay attachment={{ onConfirm, onClose }} />);
    expect(screen.getByRole('dialog', { name: 'Attach files to message' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Web links' })).toBeNull();
    expect(screen.getByText(/These files are attached to this message/)).toBeVisible();
    const file = new File(['Hello'], 'notes.txt', { type: 'text/plain' });
    await user.upload(container.querySelector('input[type="file"]')!, file);
    await user.click(screen.getByRole('button', { name: 'Attach 1 file' }));
    expect(onConfirm).toHaveBeenCalledWith([file], expect.any(Function));
    expect(onClose).toHaveBeenCalled();
    expect(addSourceFiles).not.toHaveBeenCalled();
    expect(createScatter).not.toHaveBeenCalled();
  });
  it('offers an explicit route from attachments to project sources', async () => {
    const onClose = vi.fn();
    render(<SourceImportOverlay attachment={{ onConfirm: vi.fn(), onClose }} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add project sources instead' }));
    expect(onClose).toHaveBeenCalled();
    expect(useSourceUiStore.getState()).toMatchObject({ managerOpen: true, importOpen: true });
  });
  it('uses accessible tabs while preserving and removing queued links', async () => {
    const user = userEvent.setup();
    render(<SourceImportOverlay />);

    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Blocked sites may be read through Jina Reader/)).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Web links' }));
    const links = screen.getByPlaceholderText(/example\.org/);
    await user.type(links, 'https://example.org/article{enter}https://scatter.study/notes');

    expect(screen.getByRole('button', { name: 'Add 2 sources' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Remove https://example.org/article' }));
    expect(screen.getByRole('button', { name: 'Add 1 source' })).toBeEnabled();

    await user.click(screen.getByRole('tab', { name: 'Paste text' }));
    expect(screen.getByRole('button', { name: 'Add 1 source' })).toBeEnabled();
  });

  it('closes with Escape when no add operation is active', async () => {
    const user = userEvent.setup();
    render(<SourceImportOverlay />);
    await user.keyboard('{Escape}');
    expect(useSourceUiStore.getState().importOpen).toBe(false);
  });

  it('releases the Drive button and shows one skeleton for every selected file', async () => {
    const user = userEvent.setup();
    let finishDownload!: (files: File[]) => void;
    vi.mocked(pickGoogleDriveSourceFiles).mockImplementation(async (options) => {
      options?.onSelected?.([
        { id: 'one', name: 'First.pdf', mimeType: 'application/pdf' },
        { id: 'two', name: 'Second.txt', mimeType: 'text/plain' },
      ]);
      return new Promise<File[]>((resolve) => { finishDownload = resolve; });
    });
    render(<SourceImportOverlay />);

    await user.click(screen.getByRole('button', { name: 'Google Drive' }));

    expect(await screen.findByRole('button', { name: 'Google Drive' })).toBeEnabled();
    expect(screen.getAllByRole('status', { name: /Preparing (First|Second)/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Preparing 2 files…' })).toBeDisabled();

    await act(async () => {
      finishDownload([
        new File(['one'], 'First.pdf', { type: 'application/pdf' }),
        new File(['two'], 'Second.txt', { type: 'text/plain' }),
      ]);
    });

    await waitFor(() => expect(screen.queryByRole('status', { name: /Preparing/ })).toBeNull());
    expect(screen.getByText('First.pdf')).toBeVisible();
    expect(screen.getByText('Second.txt')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add 2 sources' })).toBeEnabled();
  });

  it('creates and marks a source draft only when sources are committed', async () => {
    const user = userEvent.setup();
    const original = useGraphStore.getState().project!;
    const populated = {
      ...original,
      nodes: {
        root: {
          id: 'root',
          type: 'root' as const,
          position: { x: 0, y: 0 },
          frozen: true,
          versions: [{ header: 'Existing topic', body: 'Body.', createdAt: 1, generatedBy: 'root' as const }],
          currentVersionIndex: 0,
        },
      },
    };
    useGraphStore.setState({ project: populated, activeProjectId: populated.id, pickerOpen: true });
    vi.mocked(createScatter).mockImplementation(async () => {
      const draft = createBlankProject('New project', '');
      useGraphStore.setState({
        project: draft,
        activeProjectId: draft.id,
        projectList: [
          { id: draft.id, name: draft.name, createdAt: draft.createdAt, updatedAt: draft.updatedAt, color: draft.color },
          { id: populated.id, name: populated.name, createdAt: populated.createdAt, updatedAt: populated.updatedAt, color: populated.color },
        ],
      });
      return draft.id;
    });
    vi.mocked(addPastedSource).mockResolvedValue('source-1');
    render(<SourceImportOverlay />);

    await user.click(screen.getByRole('tab', { name: 'Paste text' }));
    await user.type(screen.getByPlaceholderText('Paste source text…'), 'A source for the new project.');
    await user.click(screen.getByRole('button', { name: 'Add 1 source' }));

    await waitFor(() => expect(useSourceUiStore.getState().topicDraft).toEqual({
      projectId: useGraphStore.getState().activeProjectId,
      returnProjectId: populated.id,
    }));
    expect(createScatter).toHaveBeenCalledOnce();
    expect(addPastedSource).toHaveBeenCalledWith(
      useGraphStore.getState().activeProjectId,
      expect.any(String),
      'A source for the new project.',
    );
  });
});
