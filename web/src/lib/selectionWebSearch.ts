export interface SearchEngine {
  id: string;
  name: string;
  urlTemplate: string;
}

export interface SelectionWebSearchSettings {
  engineId: string;
  customEngines: SearchEngine[];
}

/** Ordinary browser searches, independent of the AI web-search connection. */
export const BUILTIN_SEARCH_ENGINES: readonly SearchEngine[] = [
  { id: 'google', name: 'Google', urlTemplate: 'https://www.google.com/search?q={query}' },
  { id: 'bing', name: 'Bing', urlTemplate: 'https://www.bing.com/search?q={query}' },
  { id: 'duckduckgo', name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q={query}' },
  { id: 'yahoo', name: 'Yahoo', urlTemplate: 'https://search.yahoo.com/search?p={query}' },
  { id: 'brave', name: 'Brave Search', urlTemplate: 'https://search.brave.com/search?q={query}' },
  { id: 'ecosia', name: 'Ecosia', urlTemplate: 'https://www.ecosia.org/search?q={query}' },
  { id: 'startpage', name: 'Startpage', urlTemplate: 'https://www.startpage.com/sp/search?query={query}' },
  { id: 'yandex', name: 'Yandex', urlTemplate: 'https://yandex.com/search/?text={query}' },
  { id: 'baidu', name: 'Baidu', urlTemplate: 'https://www.baidu.com/s?wd={query}' },
];

export const DEFAULT_SEARCH_ENGINE = BUILTIN_SEARCH_ENGINES[0]!;

export function searchTemplateError(raw: string): string | null {
  const template = raw.trim();
  if (!template) return 'Enter a search URL.';
  if (template.length > 2048) return 'Use 2,048 characters or fewer for the search URL.';
  if (!/^https?:\/\//i.test(template)) return 'Use a full http:// or https:// address.';
  if (!template.includes('{query}')) return 'Add {query} where the selected text should go.';
  const withoutQuery = template.replaceAll('{query}', 'scatter-search');
  if (/[{}]/.test(withoutQuery)) return 'Use {query} as the only placeholder.';
  if (/[\s\\]/.test(template)) return 'Remove spaces, line breaks, and backslashes from the URL.';
  // A selection must never control the destination host or URL credentials.
  if (/^https?:\/\/[^/?#]*\{query\}/i.test(template)) {
    return 'Place {query} after the website address, in the path or query parameters.';
  }
  try {
    const url = new URL(withoutQuery);
    if (!url.hostname || url.username || url.password) return 'Use a website address without a username or password.';
  } catch {
    return 'Enter a valid search URL.';
  }
  return null;
}

/** One validation path for persisted settings, imports, sync, and UI edits. */
export function normalizeSelectionWebSearch(raw: unknown): SelectionWebSearchSettings {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const customEngines: SearchEngine[] = [];
  const ids = new Set(BUILTIN_SEARCH_ENGINES.map(engine => engine.id));
  for (const value of Array.isArray(data.customEngines) ? data.customEngines : []) {
    if (!value || typeof value !== 'object') continue;
    const engine = value as Record<string, unknown>;
    if (typeof engine.id !== 'string' || !/^custom-[\w-]{1,80}$/.test(engine.id) || ids.has(engine.id)
      || typeof engine.name !== 'string' || !engine.name.trim() || engine.name.trim().length > 80
      || typeof engine.urlTemplate !== 'string' || searchTemplateError(engine.urlTemplate)) continue;
    ids.add(engine.id);
    customEngines.push({ id: engine.id, name: engine.name.trim(), urlTemplate: engine.urlTemplate.trim() });
  }
  return {
    engineId: typeof data.engineId === 'string' && ids.has(data.engineId) ? data.engineId : DEFAULT_SEARCH_ENGINE.id,
    customEngines,
  };
}

export function selectedSearchEngine(settings: SelectionWebSearchSettings): SearchEngine {
  const engine = BUILTIN_SEARCH_ENGINES.find(item => item.id === settings.engineId)
    ?? settings.customEngines.find(item => item.id === settings.engineId);
  return engine && !searchTemplateError(engine.urlTemplate) ? engine : DEFAULT_SEARCH_ENGINE;
}

/** The selected phrase is URL data, never executable code or extra parameters. */
export function selectionSearchUrl(text: string, template: string): string | null {
  if (!text.trim() || searchTemplateError(template)) return null;
  try {
    return template.trim().replaceAll('{query}', encodeURIComponent(text.trim()));
  } catch {
    return null;
  }
}
