import { describe, it, expect } from 'vitest';
import {
  buildSearchIndex,
  searchNodes,
  splitByRanges,
  type SearchResult,
} from './searchNodes';
import type { ScatterNode, NodeVersion } from '@/store/types';

function ver(header: string, body: string): NodeVersion {
  return { header, body, createdAt: 0, generatedBy: 'manual' };
}
function node(
  id: string,
  versions: NodeVersion[],
  currentVersionIndex = versions.length - 1,
): ScatterNode {
  return {
    id,
    type: 'manual-empty',
    position: { x: 0, y: 0 },
    frozen: false,
    versions,
    currentVersionIndex,
  };
}
function run(nodes: ScatterNode[], query: string): SearchResult[] {
  return searchNodes(buildSearchIndex(nodes), query);
}

describe('searchNodes', () => {
  it('returns [] for an empty or whitespace-only query', () => {
    const nodes = [node('n1', [ver('Quantum', 'the quantum state')])];
    expect(run(nodes, '')).toEqual([]);
    expect(run(nodes, '   ')).toEqual([]);
  });

  it('finds an exact substring match in the body, excludes non-matches', () => {
    const nodes = [
      node('n1', [ver('Wave', 'the quantum state collapses')]),
      node('n2', [ver('Cat', 'a feline animal sleeps')]),
    ];
    const ids = run(nodes, 'quantum').map((r) => r.nodeId);
    expect(ids).toContain('n1');
    expect(ids).not.toContain('n2');
  });

  it('bold ranges in a fragment line up with the matched text', () => {
    const nodes = [node('n1', [ver('Wave', 'the quantum state collapses')])];
    const frag = run(nodes, 'quantum')[0]!.fragments[0]!;
    expect(frag.ranges.length).toBeGreaterThan(0);
    const [s, e] = frag.ranges[0]!;
    expect(frag.text.slice(s, e + 1).toLowerCase()).toBe('quantum');
  });

  it('sets titleRanges when the match is in the title', () => {
    const nodes = [node('n1', [ver('Quantum mechanics', 'plain body text here')])];
    const r = run(nodes, 'quantum')[0]!;
    expect(r.titleRanges.length).toBeGreaterThan(0);
    const [s, e] = r.titleRanges[0]!;
    expect(r.title.slice(s, e + 1).toLowerCase()).toBe('quantum');
  });

  it('is typo-tolerant (fuzzy)', () => {
    const nodes = [node('n1', [ver('Wave', 'the quantum state collapses')])];
    const ids = run(nodes, 'quantm').map((r) => r.nodeId); // missing the 'u'
    expect(ids).toContain('n1');
  });

  it('strips markdown out of fragments', () => {
    const nodes = [
      node('n1', [ver('T', 'study of [[quantum mechanics]] and **wave** behavior')]),
    ];
    const frag = run(nodes, 'wave')[0]!.fragments[0]!;
    expect(frag.text).not.toContain('*');
    expect(frag.text).not.toContain('[');
    expect(frag.text.toLowerCase()).toContain('wave');
  });

  it('returns multiple fragments when the phrase appears far apart', () => {
    const filler = 'x'.repeat(120); // wider than the merge gap
    const body = `alpha quantum beta${filler}gamma quantum delta`;
    const r = run([node('n1', [ver('T', body)])], 'quantum')[0]!;
    expect(r.fragments.length).toBe(2);
  });

  it('produces exactly one block per node even with many matches', () => {
    const res = run([node('n1', [ver('Quantum', 'quantum quantum quantum')])], 'quantum');
    expect(res.filter((r) => r.nodeId === 'n1').length).toBe(1);
  });

  it('caps fragments per node at 5', () => {
    const filler = 'x'.repeat(120);
    const body = Array.from({ length: 8 }, (_, i) => `quantum ${i}`).join(filler);
    const r = run([node('n1', [ver('T', body)])], 'quantum')[0]!;
    expect(r.fragments.length).toBe(5);
  });

  it('does not search superseded versions', () => {
    const nodes = [
      node(
        'n1',
        [
          ver('Old', 'photosynthesis happens in chloroplasts'), // v0
          ver('New', 'mitochondria are the powerhouse'), // v1 (current)
        ],
        1,
      ),
    ];
    expect(run(nodes, 'photosynthesis')).toEqual([]);
  });

  it('searches the version currently visible on the node', () => {
    const nodes = [
      node(
        'n1',
        [ver('Old', 'photosynthesis text'), ver('New', 'mitochondria powerhouse cell')],
        1,
      ),
    ];
    expect(run(nodes, 'mitochondria')[0]!.title).toBe('New');
  });

  it('cannot rank an invisible stale-version match above a visible match', () => {
    const nodes = [
      node('current-weak', [ver('Quantm', 'A short discussion of quantized systems')]),
      node(
        'stale-strong',
        [ver('Quantum', 'quantum quantum'), ver('Unrelated current title', 'plain current body')],
        1,
      ),
    ];

    const results = run(nodes, 'quantum');
    expect(results.map((result) => result.nodeId)).toEqual(['current-weak']);
  });

  it('uses the current version when two versions of one node are equally relevant', () => {
    const nodes = [
      node(
        'n1',
        [ver('Old quantum title', 'quantum detail'), ver('Current quantum title', 'quantum detail')],
        1,
      ),
    ];

    const result = run(nodes, 'quantum')[0]!;
    expect(result.title).toBe('Current quantum title');
  });

  it('has a deterministic alphabetical fallback for equally relevant nodes', () => {
    const nodes = [
      node('z-id', [ver('Zulu quantum', 'plain')]),
      node('a-id', [ver('Alpha quantum', 'plain')]),
    ];

    expect(run(nodes, 'quantum').map((result) => result.nodeId)).toEqual(['a-id', 'z-id']);
  });
});

describe('splitByRanges', () => {
  it('returns the whole string unbolded when there are no ranges', () => {
    expect(splitByRanges('hello', [])).toEqual([{ text: 'hello', bold: false }]);
  });
  it('splits around a single range (inclusive end)', () => {
    expect(splitByRanges('abcde', [[1, 2]])).toEqual([
      { text: 'a', bold: false },
      { text: 'bc', bold: true },
      { text: 'de', bold: false },
    ]);
  });
  it('handles a range at the start', () => {
    expect(splitByRanges('abc', [[0, 0]])).toEqual([
      { text: 'a', bold: true },
      { text: 'bc', bold: false },
    ]);
  });
  it('handles multiple ranges', () => {
    expect(
      splitByRanges('abcdef', [
        [0, 0],
        [2, 3],
      ]),
    ).toEqual([
      { text: 'a', bold: true },
      { text: 'b', bold: false },
      { text: 'cd', bold: true },
      { text: 'ef', bold: false },
    ]);
  });
});
