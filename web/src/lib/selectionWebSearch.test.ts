import { describe, expect, it } from 'vitest';
import { BUILTIN_SEARCH_ENGINES, normalizeSelectionWebSearch, searchTemplateError, selectedSearchEngine, selectionSearchUrl } from './selectionWebSearch';

describe('selection web search', () => {
  it.each(BUILTIN_SEARCH_ENGINES)('builds a safe search with $name', engine => {
    expect(searchTemplateError(engine.urlTemplate)).toBeNull();
    const text = 'café & tea + 日本語 #50% / 🐈';
    const url = new URL(selectionSearchUrl(text, engine.urlTemplate)!);
    expect(url.protocol).toBe('https:');
    expect([...url.searchParams.values()]).toContain(text);
    expect(url.hash).toBe('');
  });

  it('supports paths, repeated placeholders, fixed parameters, and hash-based search', () => {
    expect(selectionSearchUrl(' cat & dog ', 'https://example.com/find/{query}?language=pl&again={query}'))
      .toBe('https://example.com/find/cat%20%26%20dog?language=pl&again=cat%20%26%20dog');
    expect(selectionSearchUrl('two words', 'http://localhost:8080/#/search/{query}'))
      .toBe('http://localhost:8080/#/search/two%20words');
  });

  it.each([
    '', 'https://example.com/search', 'javascript:alert("{query}")', 'data:text/html,{query}',
    'file:///tmp/{query}', '//example.com/?q={query}', 'https://{query}.example.com/',
    'https://example.com{query}/', 'https://user:password@example.com/?q={query}',
    'https://example.com/search?q={query}&lang={language}', 'https://example.com/\n?q={query}',
    'https://example.com\\evil/?q={query}', 'https:///?q={query}',
  ])('rejects an unsafe or incomplete template: %s', template => {
    expect(searchTemplateError(template)).not.toBeNull();
    expect(selectionSearchUrl('test', template)).toBeNull();
  });

  it('does not navigate for an empty selection or malformed UTF-16', () => {
    expect(selectionSearchUrl('  ', BUILTIN_SEARCH_ENGINES[0]!.urlTemplate)).toBeNull();
    expect(selectionSearchUrl('\uD800', BUILTIN_SEARCH_ENGINES[0]!.urlTemplate)).toBeNull();
  });

  it('defaults old settings and removed choices to Google without discarding valid custom engines', () => {
    const custom = { id: 'custom-one', name: 'Library', urlTemplate: 'https://example.org/?search={query}' };
    expect(normalizeSelectionWebSearch(undefined)).toEqual({ engineId: 'google', customEngines: [] });
    expect(normalizeSelectionWebSearch({ engineId: 'missing', customEngines: [custom] }))
      .toEqual({ engineId: 'google', customEngines: [custom] });
    expect(selectedSearchEngine({ engineId: 'missing', customEngines: [] }).id).toBe('google');
  });

  it('filters invalid, duplicate, and built-in-spoofing custom definitions on import', () => {
    const custom = { id: 'custom-one', name: ' Library ', urlTemplate: ' https://example.org/?search={query} ' };
    const result = normalizeSelectionWebSearch({ engineId: 'custom-one', customEngines: [
      custom, custom, null, { ...custom, id: 'google' }, { ...custom, id: 'custom-bad', urlTemplate: 'javascript:{query}' },
      { ...custom, id: 'custom-blank', name: ' ' }, { ...custom, id: 'custom-long', name: 'a'.repeat(81) },
    ] });
    expect(result).toEqual({ engineId: 'custom-one', customEngines: [{ ...custom, name: 'Library', urlTemplate: custom.urlTemplate.trim() }] });
  });
});
