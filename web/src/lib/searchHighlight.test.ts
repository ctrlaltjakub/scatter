import { describe, it, expect, afterEach } from 'vitest';
import {
  collectSearchRanges,
  matchingBulletIndices,
  rowsWithVisibleMatch,
  updateBulletMarkers,
} from './searchHighlight';

const BODY = `Intro about quantum stuff.

- Wave mechanics
  - Superposition: states add together
  - Collapse: measurement picks one
- Photosynthesis basics
  - Chloroplast: where it happens
  - Light reaction: splits water`;

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}
function hitText(ranges: Range[]): string {
  return ranges.map((r) => r.toString()).join('').toLowerCase();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('collectSearchRanges (fuzzy — mirrors the sidebar)', () => {
  it('returns no ranges for a query under 2 characters', () => {
    const root = mount('<div class="node-header">quantum</div>');
    expect(collectSearchRanges(root, 'q')).toHaveLength(0);
    expect(collectSearchRanges(root, '')).toHaveLength(0);
  });

  it('highlights an exact word inside a header', () => {
    const root = mount('<div class="node-header">The Quantum State</div>');
    const ranges = collectSearchRanges(root, 'quantum');
    expect(ranges.length).toBeGreaterThan(0);
    expect(hitText(ranges)).toContain('quantum');
  });

  it('highlights matches inside the node body', () => {
    const root = mount('<div class="node-body">a quantum field theory</div>');
    const ranges = collectSearchRanges(root, 'quantum');
    expect(ranges.length).toBeGreaterThan(0);
    expect(hitText(ranges)).toContain('quantum');
  });

  it('skips hidden measurement copies (aria-hidden / .sc-ab-measure)', () => {
    const root = mount(
      '<div class="node-body">' +
        '<div class="sc-ab-freetext">visible quantum text</div>' +
        '<div class="sc-ab-measure" aria-hidden="true">hidden quantum copy</div>' +
        '</div>',
    );
    const ranges = collectSearchRanges(root, 'quantum');
    // Only the visible occurrence is highlighted, not the hidden lab copy.
    expect(ranges).toHaveLength(1);
  });

  it('is typo-tolerant like the sidebar (fuzzy)', () => {
    const root = mount('<div class="node-header">the quantum state collapses</div>');
    const ranges = collectSearchRanges(root, 'quantm'); // missing the 'u'
    expect(ranges.length).toBeGreaterThan(0);
  });

  it('returns nothing for an unrelated query', () => {
    const root = mount('<div class="node-header">photosynthesis</div>');
    expect(collectSearchRanges(root, 'zwxqj')).toHaveLength(0);
  });

  it('ignores text outside the node containers', () => {
    const root = mount('<div class="other-thing">quantum mechanics</div>');
    expect(collectSearchRanges(root, 'quantum')).toHaveLength(0);
  });

  it('maps offsets correctly — the highlighted text is the matched substring', () => {
    const root = mount('<div class="node-header">alpha beta gamma</div>');
    const ranges = collectSearchRanges(root, 'beta');
    expect(ranges.length).toBeGreaterThan(0);
    expect(hitText(ranges)).toContain('beta');
  });

  it('highlights across both the header and the body containers', () => {
    const root = mount(
      '<div class="node-header">Wave function</div>' +
        '<div class="node-body">the wave collapses</div>',
    );
    const ranges = collectSearchRanges(root, 'wave');
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect(hitText(ranges)).toContain('wave');
  });
});

describe('matchingBulletIndices (which bullets contain the match)', () => {
  it('matches a bullet by its title', () => {
    expect(matchingBulletIndices(BODY, 'photosynthesis')).toEqual([1]);
  });

  it('matches a bullet by a child name (hidden in compact mode)', () => {
    expect(matchingBulletIndices(BODY, 'superposition')).toEqual([0]);
  });

  it('matches a bullet by a child description', () => {
    expect(matchingBulletIndices(BODY, 'splits water')).toEqual([1]);
  });

  it('is typo-tolerant (fuzzy)', () => {
    expect(matchingBulletIndices(BODY, 'photosynthsis')).toEqual([1]);
  });

  it('returns every matching bullet, sorted', () => {
    const body = `intro.

- Alpha topic
  - foo: a shared keyword here
- Beta topic
  - bar: shared keyword again`;
    expect(matchingBulletIndices(body, 'shared')).toEqual([0, 1]);
  });

  it('returns [] for no match, short query, or no bullets', () => {
    expect(matchingBulletIndices(BODY, 'zzxqj')).toEqual([]);
    expect(matchingBulletIndices(BODY, 'p')).toEqual([]);
    expect(matchingBulletIndices('just an intro, no bullets', 'intro')).toEqual([]);
  });
});

describe('updateBulletMarkers — skip when the match is already visible', () => {
  // Returns the ROOT (the canvas-host equivalent); the card is a descendant
  // with [data-node-id], matching how SearchHighlighter calls these.
  function mountCard(visibleRowHtml: string): HTMLElement {
    const root = document.createElement('div');
    const card = document.createElement('div');
    card.dataset.nodeId = 'n1';
    card.innerHTML =
      '<div class="sc-bullet-markers"></div>' +
      '<div class="node-body"><ul class="sc-ab-list">' +
      `<li class="sc-ab-item" data-sc-anchor="b-0">${visibleRowHtml}</li>` +
      '</ul></div>';
    root.appendChild(card);
    document.body.appendChild(root);
    return root;
  }
  // The bullet's detail is collapsed → only the title is in the DOM.
  const TITLE_ONLY =
    '<div class="sc-ab-title"><span class="sc-ab-title-text">Quantum theory</span></div>';
  const BODY1 = 'intro.\n\n- Quantum theory\n  - Amplitude: hiddenword and more text';

  it('draws a marker when the match lives only in the collapsed detail', () => {
    const card = mountCard(TITLE_ONLY);
    const ranges = collectSearchRanges(card, 'hiddenword');
    updateBulletMarkers(card, 'hiddenword', () => BODY1, 1, rowsWithVisibleMatch(ranges));
    expect(card.querySelectorAll('.sc-bullet-marker')).toHaveLength(1);
  });

  it('skips the marker when the match is in the visible title', () => {
    const card = mountCard(TITLE_ONLY);
    const ranges = collectSearchRanges(card, 'quantum'); // matches the visible title
    updateBulletMarkers(card, 'quantum', () => BODY1, 1, rowsWithVisibleMatch(ranges));
    expect(card.querySelectorAll('.sc-bullet-marker')).toHaveLength(0);
  });
});
