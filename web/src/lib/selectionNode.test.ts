import { describe, it, expect, afterEach } from 'vitest';
import { selectionNodeId } from './selectionNode';

/**
 * selectionNodeId scopes the smart-selection toolbar to ONE node: it walks both
 * selection endpoints (Text or Element nodes) up to the nearest ancestor with a
 * `data-node-id`, and returns that id only when both share it. Endpoints in
 * different nodes — or outside any node — return null.
 */
afterEach(() => {
  document.body.innerHTML = '';
});

describe('selectionNodeId', () => {
  it('returns the shared node id when both endpoints sit in the same node body', () => {
    document.body.innerHTML =
      '<div data-node-id="n1"><div class="sc-ab-root"><p>hello <span>world</span></p></div></div>';
    const p = document.querySelector('p')!;
    const span = document.querySelector('span')!;
    // Endpoints are Text nodes inside <p> and <span>, as in a real Selection.
    expect(selectionNodeId(p.firstChild, span.firstChild)).toBe('n1');
  });

  it('returns null when the endpoints are in different nodes', () => {
    document.body.innerHTML =
      '<div data-node-id="n1"><p>a</p></div><div data-node-id="n2"><p>b</p></div>';
    const [pa, pb] = Array.from(document.querySelectorAll('p'));
    expect(selectionNodeId(pa!.firstChild, pb!.firstChild)).toBeNull();
  });

  it('returns null when the selection is outside any node', () => {
    document.body.innerHTML = '<p>loose text</p>';
    const p = document.querySelector('p')!;
    expect(selectionNodeId(p.firstChild, p.firstChild)).toBeNull();
  });

  it('returns null for missing endpoints', () => {
    expect(selectionNodeId(null, null)).toBeNull();
  });
});
