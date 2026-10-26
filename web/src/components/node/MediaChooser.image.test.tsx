import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MediaChooser } from './MediaChooser';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { ScatterNode } from '@/store/types';
import { configuredImageModelAvailable, generateImageInMediaNode } from '@/lib/imageGeneration';
import { attachMediaFromLink } from '@/lib/mediaActions';

vi.mock('@/lib/imageGeneration', () => ({
  generateImageInMediaNode: vi.fn(async () => undefined),
  configuredImageModelAvailable: vi.fn(() => true),
}));
vi.mock('@/lib/mediaActions', () => ({
  attachMediaFromFile: vi.fn(async () => undefined),
  attachMediaFromLink: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.mocked(generateImageInMediaNode).mockClear();
  vi.mocked(configuredImageModelAvailable).mockReturnValue(true);
  vi.mocked(attachMediaFromLink).mockClear();
  const node: ScatterNode = {
    id: 'm1', type: 'media', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: 'Media', body: 'Choose', createdAt: 1, generatedBy: 'media', contentType: 'media', width: 400 }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('media', 'm1');
  useGraphStore.getState().setProject({ ...project, nodes: { m1: node }, selection: ['m1'] });
});

describe('empty media image generation controls', () => {
  it('sends the user prompt verbatim after trimming the outside whitespace', async () => {
    render(<MediaChooser nodeId="m1" mode="generate" />);
    const prompt = screen.getByRole('textbox', { name: 'Describe the image to generate' });
    expect(prompt).toHaveAttribute('rows', '2');
    fireEvent.change(prompt, { target: { value: '  a learning diagram of a cell  ' } });
    const generate = screen.getByRole('button', { name: 'Generate image' });
    expect(generate.querySelector('svg')).toBeNull();
    fireEvent.click(generate);
    expect(generateImageInMediaNode).toHaveBeenCalledWith('m1', 'a learning diagram of a cell');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate image' })).not.toBeDisabled());
  });

  it('keeps generation disabled until an image model is configured', () => {
    vi.mocked(configuredImageModelAvailable).mockReturnValue(false);
    render(<MediaChooser nodeId="m1" mode="generate" />);
    expect(screen.getByRole('textbox', { name: 'Describe the image to generate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Generate image' })).toBeDisabled();
  });

  it('shows only files and links controls in attachment mode', async () => {
    render(<MediaChooser nodeId="m1" mode="attach" />);
    expect(screen.queryByRole('textbox', { name: 'Describe the image to generate' })).not.toBeInTheDocument();
    const link = screen.getByRole('textbox', { name: 'Image, GIF, or video link' });
    expect(link).toHaveAttribute('type', 'url');
    expect(link).not.toHaveAttribute('rows');
    fireEvent.change(link, { target: { value: 'https://example.test/diagram.png' } });
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add.closest('.sc-media-field')).toBeNull();
    expect(add.closest('.sc-media-attach-top')).not.toBeNull();
    fireEvent.click(add);
    expect(attachMediaFromLink).toHaveBeenCalledWith('m1', 'https://example.test/diagram.png');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: 'Upload a file…' })).toBeInTheDocument();
  });
});
