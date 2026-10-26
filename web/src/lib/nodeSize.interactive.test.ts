import { describe, expect, it } from 'vitest';
import type { ScatterNode } from '@/store/types';
import {
  INTERACTIVE_NODE_W,
  nodeWidth,
} from './nodeSize';

function interactiveNode(over: Partial<ScatterNode> = {}): ScatterNode {
  return {
    id: 'n',
    type: 'explain',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{
      header: 'Topic - explained',
      body: 'Explanation.',
      createdAt: 0,
      generatedBy: 'interactive',
      contentType: 'interactive',
      width: INTERACTIVE_NODE_W,
    }],
    currentVersionIndex: 0,
    ...over,
  };
}

describe('interactive node width', () => {
  it('keeps one stable landscape width while shown and hidden', () => {
    const node = interactiveNode();
    expect(nodeWidth(node)).toBe(INTERACTIVE_NODE_W);
  });

  it('normalizes legacy and previously expanded interactive widths', () => {
    const node = interactiveNode({
      versions: [{
        header: 'Legacy',
        body: 'Explanation.',
        createdAt: 0,
        generatedBy: 'interactive',
        contentType: 'interactive',
        width: 700,
      }],
    });
    expect(nodeWidth(node)).toBe(INTERACTIVE_NODE_W);
  });

  it('uses the measured width for completed portrait and wide programs', () => {
    const node = interactiveNode();
    node.versions[0]!.interactive = { html: '', model: 'fixture', providerId: 'fixture', request: 'Fixture', viewportWidth: 720, viewportHeight: 960 };
    expect(nodeWidth(node)).toBe(573);
    node.versions[0]!.interactive.viewportWidth = 1200;
    expect(nodeWidth(node)).toBe(955);
  });
});
