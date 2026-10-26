import type { Citation } from '@/providers/types';

/** Keep locally embedded raster files out of text-token billing. Images stay
 * byte-for-byte intact in the saved Markdown and are restored after editing. */
export class EmbeddedImageText {
  private readonly images = new Map<string, string>();
  private readonly references = new Map<string, string>();
  protect(text: string): string {
    return text.replace(/data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=]+/gi, data => {
      let reference = this.images.get(data);
      if (!reference) {
        reference = `app-embedded-image://image-${this.images.size + 1}`;
        this.images.set(data, reference); this.references.set(reference, data);
      }
      return reference;
    });
  }
  restore(text: string): string {
    if (!this.references.size) return text;
    return text.replace(/app-embedded-image:\/\/image-\d+/g, ref => this.references.get(ref) ?? ref);
  }
  restoreCitations(text: string, citations: Citation[]): Citation[] {
    if (!this.references.size || !citations.length) return citations;
    const replacements = [...text.matchAll(/app-embedded-image:\/\/image-\d+/g)].flatMap(match => {
      const image = this.references.get(match[0]);
      return image ? [{ start: match.index, end: match.index + match[0].length, delta: image.length - match[0].length }] : [];
    });
    const offset = (value: number | undefined) => value == null ? undefined
      : value + replacements.reduce((sum, replacement) => sum + (replacement.end <= value ? replacement.delta : 0), 0);
    return citations.map(citation => ({ ...citation, startIndex: offset(citation.startIndex), endIndex: offset(citation.endIndex) }));
  }
}

/** Context-only excerpts do not rewrite the original document. */
export function withoutEmbeddedImageData(text: string): string {
  return text.replace(/data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=]+/gi, 'embedded-image-data-omitted');
}
