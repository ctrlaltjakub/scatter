import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerImageActions } from './AnswerImageActions';
import { DEFAULT_SETTINGS, type ScatterNode } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useWikimediaTaskStore, wikimediaTaskKey } from '@/store/useWikimediaTaskStore';
import { startWikimediaDiscovery, wikimediaSearchAvailability } from '@/lib/wikimediaDiscovery';

vi.mock('@/lib/wikimediaDiscovery', () => ({
  wikimediaSearchAvailability: vi.fn(() => ({ available: true })),
  startWikimediaDiscovery: vi.fn(async (id: string, createdAt: number) => {
    useWikimediaTaskStore.getState().setTask(wikimediaTaskKey(id, createdAt), { running: true, startedAt: 1 });
  }),
}));

const node: ScatterNode = { id: 'chat', type: 'root', position: { x: 0, y: 0 }, frozen: false,
  currentVersionIndex: 0, versions: [{ header: 'Neurons', body: 'Neurons transmit signals.', createdAt: 1,
    generatedBy: 'chat', contentType: 'answer' }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(wikimediaSearchAvailability).mockReturnValue({ available: true });
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, autoFreeImages: false });
  useCitationPanelStore.getState().close();
  useWikimediaTaskStore.setState({ tasks: {} });
});

describe('chat answer free images', () => {
  it('opens direct search without starting an AI request', () => {
    render(<AnswerImageActions node={node} />);
    expect(startWikimediaDiscovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Search for free images' }));
    expect(startWikimediaDiscovery).not.toHaveBeenCalled();
    expect(useCitationPanelStore.getState().mode).toBe('wikimedia');
    fireEvent.click(screen.getByRole('button', { name: 'Hide free images' }));
    expect(screen.getByRole('button', { name: 'Search for free images' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search for free images' }));
    expect(startWikimediaDiscovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Redo agentic search' }));
    expect(startWikimediaDiscovery).toHaveBeenCalledExactlyOnceWith('chat', 1, { rerun: true });
  });

  it('keeps manual browsing available when the AI redo cannot run', () => {
    vi.mocked(wikimediaSearchAvailability).mockReturnValue({ available: false, reason: 'Choose a vision-capable secondary tasks model first.' });
    render(<AnswerImageActions node={node} />);
    const open = screen.getByRole('button', { name: 'Search for free images' });
    expect(open).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(open);
    const redo = screen.getByRole('button', { name: 'Redo agentic search' });
    expect(redo).toHaveAttribute('aria-disabled', 'true');
    expect(redo).toHaveAttribute('data-tip', 'Choose a vision-capable secondary tasks model first.');
    fireEvent.click(redo);
    expect(startWikimediaDiscovery).not.toHaveBeenCalled();
  });

  it('keeps the original show wording with automatic discovery enabled', () => {
    render(<AnswerImageActions node={node} />);
    act(() => useSettingsStore.setState({ autoFreeImages: true }));
    expect(screen.getByRole('button', { name: 'Show free images' })).toBeInTheDocument();
    expect(startWikimediaDiscovery).not.toHaveBeenCalled();
  });
});
