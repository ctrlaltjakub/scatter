// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { buildLineModel, buildSectionSegments, readingTarget, referenceForCluster } from './readingDom';
import { buildClusters } from './readingClusters';

/** Render two trimmed sentence blocks the way AdaptiveBullets does: adjacent
 *  `.sc-ab-sentence` spans, each wrapping a `.sc-ab-text` plain run, with NO
 *  whitespace text node between them. */
function twoSentenceSection(a: string, b: string): HTMLElement {
  const root = document.createElement('div');
  for (const s of [a, b]) {
    const sent = document.createElement('span');
    sent.className = 'sc-ab-sentence';
    const txt = document.createElement('span');
    txt.className = 'sc-ab-text';
    txt.textContent = s;
    sent.appendChild(txt);
    root.appendChild(sent);
  }
  return root;
}

const clusterTexts = (el: HTMLElement) => {
  const { text, segments } = buildSectionSegments(el);
  return buildClusters(text, segments).map((c) => text.slice(c.start, c.end));
};

describe('buildSectionSegments — element boundaries are word boundaries', () => {
  it('does not fuse a sentence-final period into the next sentence', () => {
    const clusters = clusterTexts(twoSentenceSection('Rome began.', 'Augustus ruled.'));
    expect(clusters).toEqual(['Rome', 'began.', 'Augustus', 'ruled.']);
    expect(clusters).not.toContain('began.Augustus');
  });

  it('keeps words separate even with no terminal punctuation between blocks', () => {
    // Defensive: two blocks split mid-thought still must not glue their words.
    const clusters = clusterTexts(twoSentenceSection('the city grew', 'quickly indeed'));
    expect(clusters).toContain('quickly');
    expect(clusters.some((c) => c.includes('grewquickly'))).toBe(false);
  });

  it('resolves the exact reference chip inside an article-plus-term cluster', () => {
    const section = document.createElement('div');
    section.append('the ');
    const chip = document.createElement('span');
    chip.className = 'ref-chip explored';
    chip.dataset.referenceParentId = 'parent';
    chip.dataset.referenceTerm = 'golden ratio';
    chip.dataset.relationChildId = 'child';
    chip.textContent = 'golden ratio';
    section.append(chip, ' appears');

    const { text, spans, segments } = buildSectionSegments(section);
    const clusters = buildClusters(text, segments);
    const reference = referenceForCluster({
      text,
      spans,
      clusters,
      lines: [],
      shape: {
        lineCount: 0,
        clusterCount: clusters.length,
        firstClusterOnLine: [],
        lastClusterOnLine: [],
        clusterHomeLine: [],
      },
    }, 0);

    expect(text.slice(clusters[0]!.start, clusters[0]!.end)).toBe('the golden ratio');
    expect(reference).toEqual({
      kind: 'term',
      parentNodeId: 'parent',
      term: 'golden ratio',
      childId: 'child',
      element: chip,
    });
  });

  it('resolves every word inside a selected-text relation, ahead of nested term chips', () => {
    const section = document.createElement('div');
    const selection = document.createElement('span');
    selection.dataset.readingRelationKind = 'selection';
    selection.dataset.readingRelationParentId = 'parent';
    selection.dataset.readingRelationChildId = 'selection-child';
    selection.dataset.relationArrowId = 'selection-arrow';
    selection.append('selected ');
    const chip = document.createElement('span');
    chip.className = 'ref-chip explored';
    chip.dataset.referenceParentId = 'parent';
    chip.dataset.referenceTerm = 'nested term';
    chip.dataset.relationChildId = 'term-child';
    chip.textContent = 'nested term';
    selection.append(chip, ' ending');
    section.append(selection);

    const { text, spans, segments } = buildSectionSegments(section);
    const clusters = buildClusters(text, segments);
    const model = {
      text,
      spans,
      clusters,
      lines: [],
      shape: {
        lineCount: 0,
        clusterCount: clusters.length,
        firstClusterOnLine: [],
        lastClusterOnLine: [],
        clusterHomeLine: [],
      },
    };

    for (let index = 0; index < clusters.length; index += 1) {
      expect(referenceForCluster(model, index)).toEqual({
        kind: 'selection',
        parentNodeId: 'parent',
        childId: 'selection-child',
        arrowId: 'selection-arrow',
        element: selection,
      });
    }
  });
});

describe('table reading order', () => {
  it('finishes each wrapped cell before the next and confines word highlights to one line', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>Before</p><table><tbody><tr><td><strong>Alpha beta</strong></td><td>Gamma delta</td></tr></tbody></table><p>After</p>';
    const textNodes: Node[] = [...root.querySelectorAll('p, strong, td:last-child')].map((element) => element.firstChild!);
    const original = document.createRange.bind(document);
    const spy = vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = original();
      range.getClientRects = () => {
        const index = textNodes.indexOf(range.startContainer);
        const top = index === 0 ? 0 : index === 3 ? 90 : 30;
        const left = index === 2 ? 150 : 0;
        const wrap = index === 1 || index === 2 ? 6 : Infinity;
        const rects = [];
        if (range.startOffset < wrap) rects.push({ top, left, height: 15, width: 40 });
        if (range.endOffset > wrap) rects.push({ top: top + 20, left, height: 15, width: 40 });
        return rects as unknown as DOMRectList;
      };
      return range;
    });
    try {
      const model = buildLineModel(root, 1)!;
      expect(model.lines.map((line) => model.text.slice(line.start, line.end).trim())).toEqual([
        'Before', 'Alpha', 'beta', 'Gamma', 'delta', 'After',
      ]);
      const line = model.lines[2]!;
      const target = readingTarget(model, 2, line.firstClusterIdx)!;
      expect(model.text.slice(target.start, target.end).trim()).toBe('beta');
    } finally { spy.mockRestore(); }
  });
});
