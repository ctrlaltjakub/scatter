import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { Arrow, ScatterNode } from '@/store/types';
import { SourceSelectionMark } from './SourceSelectionMark';
import { connectedChunkPath, padConnectedLines } from './SourceSelectionOutline';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', '..', 'app', 'globals.css'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[1]!;
}

function node(id: string): ScatterNode {
  return {
    id,
    type: id === 'parent' ? 'root' : 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{ header: id, body: 'chosen words', createdAt: 1, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

const arrow: Arrow = {
  id: 'arrow',
  kind: 'auto',
  fromNodeId: 'parent',
  toNodeId: 'child',
  sourceSelection: {
    sourceVersionCreatedAt: 1,
    createdAt: 2,
    text: 'chosen words',
    parts: [{ sourceField: 'ft', start: 0, end: 12, text: 'chosen words' }],
  },
};

beforeEach(() => {
  const project = createBlankProject('source mark', 'parent');
  useGraphStore.setState({
    project: {
      ...project,
      nodes: { parent: node('parent'), child: node('child') },
      arrows: { arrow },
      selection: [],
    },
    highlight: null,
    highlightNonce: 0,
    panTo: null,
    panRequestNonce: 0,
  });
});

afterEach(() => useGraphStore.setState({ project: null, highlight: null, panTo: null }));

describe('SourceSelectionMark', () => {
  it.each([false, true])('keeps disconnected wrapped term fragments separate (RTL=%s)', rtl => {
    const lines = [
      { left: rtl ? 10 : 400, top: 10, right: rtl ? 70 : 460, bottom: 28 },
      { left: rtl ? 300 : 10, top: 30, right: rtl ? 460 : 170, bottom: 48 },
    ];
    const path = connectedChunkPath(padConnectedLines(lines), 4);
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path.match(/Z/g)).toHaveLength(2);
  });

  it('rounds every corner of a connected multi-line relation outline', () => {
    const lines = [
      { left: 10, top: 10, right: 90, bottom: 28 },
      { left: 10, top: 28, right: 70, bottom: 46 },
    ];
    expect(padConnectedLines(lines)).toEqual([
      { left: 8, top: 8, right: 92, bottom: 28 },
      { left: 8, top: 28, right: 72, bottom: 48 },
    ]);
    const path = connectedChunkPath(padConnectedLines(lines), 4);
    expect(path).toContain('Q');
    expect(path.match(/Q/g)?.length).toBeGreaterThanOrEqual(6);
    expect(path).toMatch(/^M/);
    expect(path).toMatch(/Z$/);
  });

  it('keeps fragment borders off the text and paints one shared padded outline', () => {
    const chipRule = ruleBody('.ref-chip.active');
    const selectionRule = ruleBody('.source-selection-mark.active');

    expect(chipRule).not.toMatch(/\boutline\s*:/);
    expect(chipRule).not.toMatch(/box-shadow\s*:/);
    expect(chipRule).not.toMatch(/animation\s*:/);
    expect(selectionRule).not.toMatch(/background-image\s*:/);
    expect(selectionRule).not.toMatch(/box-shadow\s*:/);
    expect(selectionRule).not.toMatch(/animation\s*:/);
    expect(css).toContain('.relation-active-outline { stroke-width: 2px; }');
    expect(css).toMatch(/@keyframes sc-relation-outline-pulse/);
    expect(css).toContain('.relation-latent-outline-svg {');
    expect(ruleBody('.relation-latent-outline')).toMatch(/stroke-linecap:\s*round/);
    expect(css).toContain('[data-theme="mocha"] .relation-latent-outline {');
    expect(ruleBody('[data-theme="mocha"] .relation-latent-outline')).toMatch(/stroke:[^;]*55%/);
  });

  it('uses explored styling, the custom clickable class, and relation navigation', () => {
    const { getByRole } = render(
      <SourceSelectionMark arrow={arrow} active={false}>chosen words</SourceSelectionMark>,
    );
    const mark = getByRole('button', { name: 'Show "chosen words"' });
    expect(mark).toHaveClass('source-selection-mark', 'explored');
    expect(mark).toHaveAttribute('data-reading-relation-kind', 'selection');
    expect(mark).toHaveAttribute('data-reading-relation-parent-id', 'parent');
    expect(mark).toHaveAttribute('data-reading-relation-child-id', 'child');
    expect(mark).toHaveAttribute('data-relation-arrow-id', 'arrow');

    fireEvent.click(mark);

    expect(useGraphStore.getState().panTo?.id).toBe('child');
    expect(useGraphStore.getState().highlight).toMatchObject({
      arrowId: 'arrow',
      source: 'chip',
    });
  });

  it('becomes active from either child selection or its exact transient arrow highlight', () => {
    const { getByRole, rerender } = render(
      <SourceSelectionMark arrow={arrow} active={false}>chosen words</SourceSelectionMark>,
    );
    const mark = getByRole('button');
    expect(mark).not.toHaveClass('active');

    act(() => useGraphStore.getState().setSelection(['child']));
    rerender(<SourceSelectionMark arrow={arrow} active>chosen words</SourceSelectionMark>);
    expect(mark).toHaveClass('active');

    act(() => {
      useGraphStore.getState().setSelection([]);
      useGraphStore.getState().flashHighlight({
        parentNodeId: 'parent',
        childNodeId: 'child',
        arrowId: 'arrow',
        source: 'node',
      });
    });
    rerender(<SourceSelectionMark arrow={arrow} active>chosen words</SourceSelectionMark>);
    expect(mark).toHaveClass('active');
  });

  it('supports Enter and Space while stopping pointer-down propagation', () => {
    let pointerDownBubbled = false;
    const { getByRole } = render(
      <div onPointerDown={() => { pointerDownBubbled = true; }}>
        <SourceSelectionMark arrow={arrow} active={false}>chosen words</SourceSelectionMark>
      </div>,
    );
    const mark = getByRole('button');
    fireEvent.pointerDown(mark);
    expect(pointerDownBubbled).toBe(false);

    fireEvent.keyDown(mark, { key: 'Enter' });
    const firstNonce = useGraphStore.getState().highlight!.nonce;
    fireEvent.keyDown(mark, { key: ' ' });
    expect(useGraphStore.getState().highlight!.nonce).toBeGreaterThan(firstNonce);
  });
});
