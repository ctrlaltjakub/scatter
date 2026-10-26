import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImageProjectInput } from './ImageProjectInput';
import { prepareProjectImage } from '@/lib/projectStart';

vi.mock('@/lib/projectStart', () => ({ prepareProjectImage: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const prepared = { title: 'Diagram', previewUrl: 'blob:preview', media: {
  source: 'asset' as const, kind: 'image' as const, naturalWidth: 100, naturalHeight: 100 },
};

describe('image project input', () => {
  it('uploads and starts with the chosen file', async () => {
    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    vi.mocked(prepareProjectImage).mockResolvedValue({ ...prepared, file });
    const onStart = vi.fn();
    const { container } = render(<ImageProjectInput active busy={false} onStart={onStart} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await screen.findByRole('img', { name: 'Diagram' });
    expect(prepareProjectImage).toHaveBeenCalledWith(file, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('button', { name: 'Start project' }));
    expect(onStart).toHaveBeenCalledWith({ ...prepared, file });
  });
  it('handles drag-and-drop and only captures image paste while its tab is active', async () => {
    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    vi.mocked(prepareProjectImage).mockResolvedValue({ ...prepared, file });
    const props = { busy: false, onStart: vi.fn() };
    const { container, rerender } = render(<ImageProjectInput active={false} {...props} />);
    fireEvent.paste(document, { clipboardData: { files: [file] } });
    expect(prepareProjectImage).not.toHaveBeenCalled();
    rerender(<ImageProjectInput active {...props} />);
    fireEvent.paste(document, { clipboardData: { files: [file] } });
    await waitFor(() => expect(prepareProjectImage).toHaveBeenCalledTimes(1));
    fireEvent.drop(container.querySelector('.image-project-dropzone')!, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(prepareProjectImage).toHaveBeenCalledTimes(2));
  });
  it('shows link failures inline without creating a project', async () => {
    vi.mocked(prepareProjectImage).mockRejectedValue(new Error('Could not load this image.'));
    const onStart = vi.fn();
    render(<ImageProjectInput active busy={false} onStart={onStart} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Image link' }), { target: { value: 'https://example.com/page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this image.');
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start project' })).toBeDisabled();
  });
  it('cancels pending reads on unmount', () => {
    vi.mocked(prepareProjectImage).mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<ImageProjectInput active busy={false} onStart={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Image link' }), { target: { value: 'https://example.com/slow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    const signal = vi.mocked(prepareProjectImage).mock.calls[0]![1];
    unmount(); expect(signal.aborted).toBe(true);
  });
});
