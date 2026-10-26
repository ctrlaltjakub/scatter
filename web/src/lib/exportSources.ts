import type { NodeVersion } from '@/store/types';
import { sourceDomain } from './citations';

export type ExportSources = Pick<NodeVersion, 'sources' | 'internalSources'>;

/** Keep citation numbers from this version; never renumber exported text. */
export function exportSourceEntries(version?: ExportSources) {
  return [
    ...(version?.sources ?? []).map(source => ({ marker: `⟦${source.n}⟧`,
      label: source.domain || sourceDomain(source.url, source.title) || source.title || source.url,
      url: source.url, excerpt: undefined as string | undefined })),
    ...(version?.internalSources ?? []).map(source => ({ marker: `(${source.n})`,
      label: `${source.sourceTitle}${source.page ? `, page ${source.page}` : ''}`,
      url: source.originalUrl, excerpt: source.excerpt })),
  ];
}

export function withExportBibliography(markdown: string, sources?: ExportSources): string {
  const entries = exportSourceEntries(sources);
  if (!entries.length) return markdown;
  const escape = (value: string) => value.replace(/[\\[\]*_<>]/g, '\\$&');
  const lines = entries.map(entry => {
    const label = escape(entry.label);
    const linked = entry.url && /^https?:\/\//i.test(entry.url)
      ? `[${label}](${entry.url.replace(/[\s()]/g, char => encodeURIComponent(char))})` : label;
    return `${entry.marker} ${linked}${entry.excerpt ? `\n\n> ${entry.excerpt.replace(/\n/g, '\n> ')}` : ''}`;
  });
  return `${markdown.trimEnd()}\n\n## Bibliography\n\n${lines.join('\n\n')}\n`;
}
