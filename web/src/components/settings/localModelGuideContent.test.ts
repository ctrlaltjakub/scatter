import { describe, expect, it } from 'vitest';
import { markedTerms, stripTermMarkers } from '@/lib/termMarking';
import { parseTermPreviews, termPreviewKey } from '@/lib/termPreviewCore';
import { localModelGuideSource } from './localModelGuideContent';
import guide from './localModelGuide.generated.json';

describe('bundled local guide enrichment', () => {
  it('uses the requested model and keeps the guide copy unchanged', () => {
    expect(guide.model).toBe('gpt-6.1-sol');
    expect(guide.workflow).toBe('markTerms + completeTermPreviews');
    expect(stripTermMarkers(guide.body)).toBe(localModelGuideSource);
  });
  it('has a valid app-format preview for every marked term, without touching API examples', () => {
    const terms = markedTerms(guide.body);
    expect(terms.length).toBeGreaterThan(10);
    const previews: Record<string, string> = guide.previews;
    expect(Object.keys(previews).sort()).toEqual([...new Set(terms.map(termPreviewKey))].sort());
    for (const term of terms) {
      const text = previews[termPreviewKey(term)]!;
      const raw = JSON.stringify({ previews: [{ id: 0, parts: text.split(/\*\*([^*]+)\*\*/g) }] });
      expect(parseTermPreviews(raw, [term])[termPreviewKey(term)]).toBe(text);
    }
    for (const code of ['GET /v1/models', 'POST /v1/chat/completions', 'http://localhost:11434/v1', 'Authorization']) {
      expect(guide.body).toContain('`' + code + '`');
      expect(terms).not.toContain(code);
    }
  });
});
