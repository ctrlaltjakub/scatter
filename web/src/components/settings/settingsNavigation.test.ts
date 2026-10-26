import { describe, expect, it } from 'vitest';
import { SETTINGS_PAGES, searchSettingsPages } from './settingsNavigation';

describe('settings navigation inventory', () => {
  it('has a unique destination for every settings area', () => {
    expect(new Set(SETTINGS_PAGES.map((page) => page.id)).size).toBe(10);
    expect(searchSettingsPages('')).toEqual(SETTINGS_PAGES);
  });
  it('keeps system prompts and developer controls under DO NOT TOUCH, after everyday settings', () => {
    expect([...new Set(SETTINGS_PAGES.map((page) => page.group))]).toEqual([
      'Personalize',
      'Artificial intelligence',
      'Data',
      'DO NOT TOUCH',
    ]);
    expect(SETTINGS_PAGES.filter((page) => page.group === 'DO NOT TOUCH').map((page) => page.id))
      .toEqual(['prompts', 'dev']);
    expect(SETTINGS_PAGES.filter((page) => page.group === 'Artificial intelligence').map((page) => page.id))
      .toEqual(['providers', 'openrouter', 'models']);
  });
  it.each([
    ['DARK', 'theme'],
    ['font', 'theme'],
    ['custom fonts', 'theme'],
    ['paragraph', 'theme'],
    ['reassign', 'theme'],
    ['web search engine', 'canvas'],
    ['custom URL', 'canvas'],
    ['keyboard', 'shortcuts'],
    ['API key', 'providers'],
    ['Gemini', 'providers'],
    ['secondary previews', 'models'],
    ['resolution', 'models'],
    ['reasoning', 'models'],
    ['chat instructions', 'canvas'],
    ['system prompts', 'prompts'],
    ['token limits', 'models'],
    ['new chat nodes', 'canvas'],
    ['chunking default', 'canvas'],
    ['camera group', 'canvas'],
    ['drag edge', 'canvas'],
    ['branch project', 'canvas'],
    ['fact check', 'prompts'],
    ['webdav', 'sync'],
    ['history restore', 'sync'],
    ['export', 'data'],
    ['wipe', 'data'],
    ['physics', 'dev'],
    ['webgl', 'dev'],
  ])('finds %s without knowing the page name', (query, id) => {
    expect(searchSettingsPages(`  ${query}  `).some((page) => page.id === id)).toBe(true);
  });
  it('does not return unrelated results', () => {
    expect(searchSettingsPages('not-a-setting')).toEqual([]);
    expect(searchSettingsPages('dark')).toHaveLength(1);
  });
});
