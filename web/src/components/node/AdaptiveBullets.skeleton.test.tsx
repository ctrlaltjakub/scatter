/**
 * One-line skeleton (Part 4b).
 *
 * While a single bullet is being expand-part'd, its L2 detail is chewed back to
 * empty before the new text streams. During that empty window the targeted
 * bullet shows a one-line shimmer (`.sc-ab-skel-line`) — visible list only, so
 * it never feeds node-size measurement.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { AdaptiveBullets } from './AdaptiveBullets';
import { useRewriteStore, type RewriteRecord } from '@/store/useRewriteStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { useSettingsStore } from '@/store/useSettingsStore';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    const cls = el.classList;
    let h = 0;
    const w = 480;
    if (cls?.contains('sc-ab-root')) h = 280;
    else if (cls?.contains('sc-ab-freetext')) h = 40;
    else if (cls?.contains('sc-ab-item')) h = 28;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
});

// Bullet 0 ("One") has NO children (the chewed-empty state); bullet 1 ("Two")
// has children. A partial rewrite targeting bullet 0 should put a one-line
// skeleton on bullet 0 only.
const BODY = `Intro paragraph.

- **One**
- **Two**
  - a: first
  - b: second`;

function targetBullet(index: number) {
  const rec: RewriteRecord = {
    id: 'r1',
    nodeId: 'p1',
    kind: 'partial',
    target: { kind: 'bullet', index },
    originalSectionText: '',
    abortController: new AbortController(),
  };
  useRewriteStore.getState().addRecord(rec);
}

describe('AdaptiveBullets — one-line skeleton', () => {
  beforeEach(() => {
    useRewriteStore.setState({ activeByNode: {}, workingBody: {} });
    useActiveIdxStore.setState({ byNodeId: {} });
    useSettingsStore.setState({ sentencePerLine: false, justifyParagraph: false });
  });

  it('shows a one-line skeleton on a bullet being expanded while its detail is empty', () => {
    targetBullet(0);
    const { container } = render(
      <AdaptiveBullets body={BODY} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    const skel = container.querySelectorAll('.sc-ab-skel-line');
    expect(skel.length).toBe(1); // visible list only — not the measurement clones
    // It sits inside the targeted (first) bullet item.
    const firstItem = container.querySelector('.sc-ab-root > .sc-ab-list > .sc-ab-item');
    expect(firstItem!.querySelector('.sc-ab-skel-line')).not.toBeNull();
  });

  it('shows no skeleton when no rewrite targets the bullet', () => {
    const { container } = render(
      <AdaptiveBullets body={BODY} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    expect(container.querySelector('.sc-ab-skel-line')).toBeNull();
  });

  it('shows no skeleton on a targeted bullet that still has its detail', () => {
    targetBullet(1); // bullet 1 has children → not empty → no skeleton
    const { container } = render(
      <AdaptiveBullets body={BODY} parentNodeId="p1" onReferenceClick={() => {}} />,
    );
    expect(container.querySelector('.sc-ab-skel-line')).toBeNull();
  });
});
