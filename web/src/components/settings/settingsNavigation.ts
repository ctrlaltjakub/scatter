export const SETTINGS_PAGES = [
  {
    id: 'theme',
    group: 'Personalize',
    label: 'Appearance',
    description: 'Choose the theme, node fonts, paragraph layout, and canvas colors.',
    keywords: 'theme light dark system accent hue shift saturation brightness desaturate darken color arrows resize font typeface dyslexic comic sans monospace custom fonts upload ttf otf woff woff2 reading paragraph sentence lines justify group colors automatic assignment opposites golden angle hierarchy reassign',
  },
  {
    id: 'canvas',
    group: 'Personalize',
    label: 'Canvas and nodes',
    description: 'Set camera behavior, chat instructions, writing controls, and text-selection search.',
    keywords:
      'camera automatic pan zoom movement focus selecting group branch project drag edge create generation expand bullets panels reading ruler delete follow-up enter sends newline selection toolbar web search engine google bing duckduckgo yahoo brave ecosia startpage yandex baidu custom URL query normal chat instructions new chat nodes information chunking default',
  },
  {
    id: 'shortcuts',
    group: 'Personalize',
    label: 'Shortcuts',
    description: 'Look up shortcuts and customize app keybindings.',
    keywords:
      'keyboard keys bindings shortcuts hotkeys navigation focus select undo redo pin zoom wasd pan reset',
  },
  {
    id: 'providers',
    group: 'Artificial intelligence',
    label: 'AI providers',
    description: 'Add and manage your provider API keys and connections.',
    keywords:
      'api key connection provider openai anthropic openrouter routing cheapest fast start gemini ollama lm studio custom base url credentials name searxng local web search roles smart cheap coding optional image',
  },
  {
    id: 'openrouter',
    group: 'Artificial intelligence',
    label: 'OpenRouter',
    description: 'Review usage, spending limits, and your OpenRouter connection.',
    keywords: 'openrouter spending budget limit allowance credits usage billing balance daily weekly monthly activity free requests',
  },
  {
    id: 'models',
    group: 'Artificial intelligence',
    label: 'Models and generation',
    description: 'Assign models, configure automatic tasks, and set token limits.',
    keywords:
      'main model library enabled reorder selected ctrl m text secondary tasks term marking previews automatic enrichment updates recommendations curated free images vision web search interactive explanations image generation quality size resolution aspect ratio output format background compression seed moderation fidelity reasoning effort price cost context tokens megapixels generation token limits allowance budget show all models compatibility filtering override metadata unverified',
  },
  {
    id: 'sync',
    group: 'Data',
    label: 'Synchronization',
    description: 'Sync projects and app settings between devices.',
    keywords:
      'sync api keys credentials risk encryption cloud google drive webdav nextcloud server username password remote folder device history restore versions pause disconnect reconnect',
  },
  {
    id: 'data',
    group: 'Data',
    label: 'Backups',
    description: 'Export backups, import saved data, or remove local data.',
    keywords:
      'data export import settings project backup file zip json erase remove wipe reset all app data api keys',
  },
  {
    id: 'prompts',
    group: 'DO NOT TOUCH',
    label: 'System prompts',
    description: 'Edit system instructions and task templates sent to models.',
    keywords:
      'information chunking system prompt templates custom defaults reset overwrite warning memory compaction titles term selection previews root follow-up modify explain fact check interactive recommend images mask crop transcription OCR sources retrieval local web search',
  },
  {
    id: 'dev',
    group: 'DO NOT TOUCH',
    label: 'Developer',
    description: 'Fine-grained controls and tools for testing the app.',
    keywords:
      'dev physics forces friction repulsion spring gravity bullet sizing dimensions width height reset overwrite warning diagnostics google drive renewal conflict welcome start screen pixel ruler webgl failure decorative motion animation animate pause remote desktop loading orbits orbs topic suggestions',
  },
] as const;

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]['id'];

export function searchSettingsPages(query: string) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return SETTINGS_PAGES.filter((page) => {
    const text = `${page.label} ${page.description} ${page.keywords}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
