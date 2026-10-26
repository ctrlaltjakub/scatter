import { describe, expect, it } from 'vitest';
import { buildSources, extractInlineCitations, placeCitationMarkersReliable, renumberCitations } from '@/lib/citations';
import type { Citation } from '@/providers/types';
import { chatSystemPrompt } from './context';
import { applyTermSelection } from '@/lib/termMarking';

describe('chat citation locations', () => {
  it('removes citation-only publisher labels before term marking, as in the chairwork answer', () => {
    const body = 'Face the chairs toward each other ([Transformational Chairwork](https://transformationalchairwork.com/guide)). '
      + 'Sit adjacent ([BehaveNet](https://behavenet.com/chairwork)). '
      + 'Visualize a person ([British Psychological Society](https://bps.org.uk/article)). '
      + 'Track somatic cues ([Wikipedia](https://en.wikipedia.org/wiki/Chairwork)).';
    const citations = extractInlineCitations(body);
    const placed = placeCitationMarkersReliable(body, citations, buildSources(citations), 'message-end');
    expect(placed).toBe('Face the chairs toward each other⟦1⟧. Sit adjacent⟦2⟧. Visualize a person⟦3⟧. Track somatic cues⟦4⟧.');
    expect(applyTermSelection(placed, JSON.stringify({ terms: ['Transformational Chairwork', 'BehaveNet', 'British Psychological Society', 'Wikipedia', 'somatic cues'] })))
      .toBe('Face the chairs toward each other⟦1⟧. Sit adjacent⟦2⟧. Visualize a person⟦3⟧. Track [[somatic cues]]⟦4⟧.');
  });

  it('removes multiple parenthetical source labels but preserves narrative mentions and linked concepts', () => {
    const body = 'Wikipedia describes [chairwork](https://en.wikipedia.org/wiki/Chairwork) as a technique '
      + '([Wikipedia](https://en.wikipedia.org/wiki/Chairwork); [British Psychological Society](https://bps.org.uk/guide)).';
    const citations = extractInlineCitations(body);
    expect(placeCitationMarkersReliable(body, citations, buildSources(citations), 'message-end'))
      .toBe('Wikipedia describes chairwork⟦1⟧ as a technique⟦1⟧⟦2⟧.');
  });
  it('preserves explanatory parentheses containing meaningful linked text', () => {
    const body = 'Use the method (also called [chairwork](https://example.org/guide)) with care.';
    const citations = extractInlineCitations(body);
    expect(placeCitationMarkersReliable(body, citations, buildSources(citations), 'message-end'))
      .toBe('Use the method (also called chairwork⟦1⟧) with care.');
  });
  it('removes emphasized publisher labels even when annotations cover the links', () => {
    const body = 'Track **somatic cues** ([**Wikipedia**](https://en.wikipedia.org/wiki/Chairwork)).';
    const citations: Citation[] = [{ url: 'https://en.wikipedia.org/wiki/Chairwork',
      startIndex: body.indexOf('['), endIndex: body.lastIndexOf(')') }];
    expect(placeCitationMarkersReliable(body, citations, buildSources(citations), 'message-end'))
      .toBe('Track **somatic cues**⟦1⟧.');
  });
  it('instructs searched chats to use neutral source labels', () => {
    expect(chatSystemPrompt(true, '', true)).toContain('Use the neutral label "source"');
    expect(chatSystemPrompt(false, '', true)).toContain('not merely where you found the information');
    expect(chatSystemPrompt(false, '', false)).not.toContain('Use the neutral label "source"');
  });
  it('places unlocatable citations after the complete message, without changing claim-local links', () => {
    const citations: Citation[] = [{ url: 'https://example.org/a', startIndex: 0, endIndex: 0, offsetKind: 'citation-label' },
      { url: 'https://example.org/b', startIndex: 0, endIndex: 0, offsetKind: 'citation-label' }];
    const body = 'The [God-image](https://example.org/b) is a concept.\n\nAnother paragraph.\n\n```js\nconst n = 1;\n```';
    const sources = buildSources(citations);
    const result = renumberCitations(placeCitationMarkersReliable(body, citations, sources, 'message-end'), sources, 3, true);
    expect(result.body).toBe('The God-image⟦3⟧ is a concept.\n\nAnother paragraph.\n\n```js\nconst n = 1;\n```\n\n⟦4⟧');
    expect(result.sources.map((source) => source.n)).toEqual([3, 4]);
  });
  it('keeps source-only Gemini annotations without attributing them to the first paragraph', () => {
    const body = 'First subject.\n\nAnother subject.';
    const citations: Citation[] = [1, 2, 3, 4, 5].map((n) => ({ url: `https://example.org/${n}`,
      startIndex: 0, endIndex: 0, offsetKind: 'citation-label' }));
    const sources = buildSources(citations);
    const placed = placeCitationMarkersReliable(body, citations, sources, 'sources-only');
    const result = renumberCitations(placed, sources, 3, true);
    expect(result.body).toBe(body);
    expect(result.sources.map((source) => source.n)).toEqual([3, 4, 5, 6, 7]);
  });
  it('retains claim-local links and numbers internal sources before web sources', () => {
    const citations: Citation[] = [{ url: 'https://example.org/a' }, { url: 'https://example.org/b' }];
    const sources = buildSources(citations);
    const body = 'First claim (1).\n\nOther claim [source](https://example.org/b).';
    const result = renumberCitations(placeCitationMarkersReliable(body, citations, sources, 'sources-only'), sources, 2, true);
    expect(result.body).toBe('First claim (1).\n\nOther claim⟦2⟧.');
    expect(result.sources.map((source) => source.url)).toEqual(['https://example.org/b', 'https://example.org/a']);
    expect(chatSystemPrompt(false, '', true)).toContain('immediately after the specific claim');
  });
  it('preserves the meaningful link labels in the observed live Gemini answer', () => {
    const sources = buildSources([{ url: 'https://example.org/self' }, { url: 'https://example.org/numinous' }]);
    const body = 'He described the [God-image](https://example.org/self).\n\nFor Jung, such [numinous experiences](https://example.org/numinous) matter.';
    expect(placeCitationMarkersReliable(body, [], sources, 'sources-only'))
      .toBe('He described the God-image⟦1⟧.\n\nFor Jung, such numinous experiences⟦2⟧ matter.');
  });
  it('supports mixed annotated citation labels and meaningful Markdown links', () => {
    const body = 'The [God-image](https://example.org/a) is a concept. [Found source]';
    const citations: Citation[] = [{ url: 'https://example.org/a', startIndex: 4, endIndex: 15, offsetKind: 'citation-label' },
      { url: 'https://example.org/b', startIndex: body.indexOf('[Found source]'), endIndex: body.length, offsetKind: 'citation-label' }];
    expect(placeCitationMarkersReliable(body, citations, buildSources(citations), 'sources-only'))
      .toBe('The God-image⟦1⟧ is a concept.⟦2⟧');
  });
  it.each(['https://en.wikipedia.org/wiki/Self_(Jungian_psychology)',
    'https://example.org/a_(b_(c))'])('preserves balanced parentheses in a source URL: %s', (url) => {
    const body = `The [Self](${url}) is a concept.`;
    const citations = extractInlineCitations(body);
    expect(citations.map((citation) => citation.url)).toEqual([url]);
    expect(placeCitationMarkersReliable(body, citations, buildSources(citations), 'sources-only'))
      .toBe('The Self⟦1⟧ is a concept.');
  });
});
