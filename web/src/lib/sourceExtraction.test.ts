import { describe, expect, it, vi } from 'vitest';

const transcribeSourceImage = vi.hoisted(() => vi.fn());
vi.mock('./secondaryTaskCompletion', () => ({ transcribeSourceImage }));

import { extractSourceBlob, sourceKindForFile } from './sourceExtraction';

describe('source extraction', () => {
  it('recognizes the supported local source formats', () => {
    expect(sourceKindForFile(new File(['x'], 'notes.md', { type: 'text/markdown' }))).toBe('markdown');
    expect(sourceKindForFile(new File(['x'], 'scan.pdf', { type: 'application/pdf' }))).toBe('pdf');
    expect(sourceKindForFile(new File(['x'], 'photo.webp', { type: 'image/webp' }))).toBe('image');
    expect(sourceKindForFile(new File(['x'], 'archive.zip', { type: 'application/zip' }))).toBeNull();
  });

  it('resumes a saved image transcription without paying for OCR again', async () => {
    transcribeSourceImage.mockReset();
    const extracted = await extractSourceBlob(
      new Blob(['discarded image bytes'], { type: 'image/png' }),
      'image',
      undefined,
      undefined,
      new Map([[1, 'Already transcribed text']]),
    );

    expect(extracted.blocks).toEqual([expect.objectContaining({
      page: 1,
      aiTranscription: true,
      text: 'Already transcribed text',
    })]);
    expect(transcribeSourceImage).not.toHaveBeenCalled();
  });
});
