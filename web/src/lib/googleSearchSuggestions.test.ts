import { describe, expect, it } from 'vitest';
import type { NodeVersion, Project } from '@/store/types';
import { createBlankProject } from '@/store/useGraphStore';
import { pruneInheritedGoogleSearchSuggestions } from './googleSearchSuggestions';

function version(createdAt: number, snippets: string[], urls: string[], webSearched = true): NodeVersion {
  return { createdAt, header: 'Topic', body: 'Version content.', generatedBy: 'root', webSearched,
    googleSearchSuggestions: snippets,
    sources: urls.map((url, index) => ({ n: index + 1, url })) };
}
function project(versions: NodeVersion[]): Project {
  return { ...createBlankProject('Search history', 'node'), nodes: { node: { id: 'node', type: 'root',
    frozen: false, position: { x: 0, y: 0 }, currentVersionIndex: versions.length - 1, versions } } };
}

describe('historical Google search row cleanup', () => {
  it('removes unrelated inherited rows but preserves each original version', () => {
    const original = project([
      version(1, ['first'], ['https://first.test']),
      version(2, ['first', 'second'], ['https://second.test']),
      version(3, ['first', 'second', 'third'], ['https://third.test']),
      version(4, ['first', 'second', 'third'], [], false),
    ]);
    const cleaned = pruneInheritedGoogleSearchSuggestions(original);
    expect(cleaned.nodes.node!.versions.map(item => item.googleSearchSuggestions))
      .toEqual([['first'], ['second'], ['third'], undefined]);
    expect(cleaned.nodes.node!.versions[0]).toBe(original.nodes.node!.versions[0]);
    expect(original.nodes.node!.versions[2]!.googleSearchSuggestions).toEqual(['first', 'second', 'third']);
    expect(cleaned.nodes.node!.versions.map(item => [item.body, item.sources]))
      .toEqual(original.nodes.node!.versions.map(item => [item.body, item.sources]));
    expect(pruneInheritedGoogleSearchSuggestions(cleaned)).toBe(cleaned);
  });

  it('retains attribution for cited content kept by a partial edit', () => {
    const original = project([
      version(1, ['first'], ['https://first.test']),
      version(2, ['first', 'second'], ['https://first.test', 'https://second.test']),
    ]);
    expect(pruneInheritedGoogleSearchSuggestions(original)).toBe(original);
  });

  it('does not guess when an origin has no sources or a new search returned identical HTML', () => {
    const original = project([
      version(1, ['unknown'], []),
      version(2, ['unknown', 'first'], ['https://first.test']),
      version(3, ['first'], ['https://second.test']),
    ]);
    expect(pruneInheritedGoogleSearchSuggestions(original)).toBe(original);
  });

  it('ignores suggestions belonging to other nodes', () => {
    const original = project([version(1, ['same'], ['https://first.test'])]);
    original.nodes.other = { ...original.nodes.node!, id: 'other', versions: [
      version(2, ['same', 'new'], ['https://second.test']), version(3, ['same', 'new'], ['https://second.test']),
    ] };
    expect(pruneInheritedGoogleSearchSuggestions(original)).toBe(original);
  });
});
