import type { Project } from '@/store/types';

/** Attribution UI is presentation metadata, not prompt text. Deduplicate it
 * across partial rewrites and bound imported/provider payloads. */
export function mergeGoogleSearchSuggestions(...groups: (readonly string[] | undefined)[]): string[] | undefined {
  const snippets = [...new Set(groups.flatMap(group => Array.isArray(group)
    ? group.filter(value => typeof value === 'string' && value.length <= 100_000) : []))];
  return snippets.length ? snippets.slice(-32) : undefined;
}

/** Repair historical carry-over on load, without changing text or citations.
 * Earlier builds copied all old widgets into regenerated versions. A widget
 * first seen in an older version is unrelated when none of that version's
 * sources remain. Unknown provenance is deliberately left alone. */
export function pruneInheritedGoogleSearchSuggestions(project: Project): Project {
  let nodes = project.nodes;
  for (const node of Object.values(project.nodes)) {
    if (node.versions.length < 2) continue;
    const origins = new Map<string, Set<string>>();
    let versions = node.versions;
    for (let index = 0; index < node.versions.length; index++) {
      const version = node.versions[index]!;
      const snippets = version.googleSearchSuggestions;
      if (!snippets?.length) continue;
      const urls = new Set(version.sources?.map(source => source.url));
      const relevant = snippets.filter(snippet => {
        const origin = origins.get(snippet);
        if (!origin) { origins.set(snippet, urls); return true; }
        return !origin.size || [...origin].some(url => urls.has(url));
      });
      // Identical provider HTML can legitimately be returned by a fresh search.
      // Without a fresh widget or an explicit lack of search, do not guess.
      if (relevant.length === snippets.length || (!relevant.length && version.webSearched)) continue;
      if (versions === node.versions) versions = [...versions];
      versions[index] = { ...version, googleSearchSuggestions: relevant.length ? relevant : undefined };
    }
    if (versions !== node.versions) {
      if (nodes === project.nodes) nodes = { ...nodes };
      nodes[node.id] = { ...node, versions };
    }
  }
  return nodes === project.nodes ? project : { ...project, nodes };
}
