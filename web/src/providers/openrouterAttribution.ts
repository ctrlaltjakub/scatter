// OpenRouter's HTTP-Referer identifies the app, not the user's current page.
export const OPENROUTER_ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://scatter.study',
  'X-Title': 'Scatter',
} as const;
