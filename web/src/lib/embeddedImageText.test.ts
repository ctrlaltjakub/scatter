import { describe, expect, it } from 'vitest';
import { EmbeddedImageText, withoutEmbeddedImageData } from './embeddedImageText';

describe('embedded Markdown image request protection', () => {
  const data = 'data:image/png;base64,' + 'abcd'.repeat(5000);
  it('deduplicates file references and restores the exact original bytes', () => {
    const images = new EmbeddedImageText();
    const source = `![Figure](${data}) and ![Again](${data})`;
    const protectedText = images.protect(source);
    expect(protectedText.length).toBeLessThan(150);
    expect(protectedText).not.toContain('base64');
    expect(images.restore(protectedText)).toBe(source);
  });
  it('preserves citation locations after restoring a file before cited text', () => {
    const images = new EmbeddedImageText();
    const protectedText = images.protect(`![Figure](${data})\nA cited statement.`);
    const startIndex = protectedText.indexOf('A cited');
    const [citation] = images.restoreCitations(protectedText, [{ url: 'https://example.com', startIndex, endIndex: protectedText.length }]);
    expect(images.restore(protectedText).slice(citation!.startIndex, citation!.endIndex)).toBe('A cited statement.');
    expect(withoutEmbeddedImageData(`Before ${data} after`)).toBe('Before embedded-image-data-omitted after');
  });
});
