import { describe, expect, it } from 'vitest';
import type { ScatterNode } from '@/store/types';
import {
  INTERACTIVE_NODE_W,
  nodeWidth,
  nodeBodyMaxH,
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

  it.each([[960, 720], [720, 960], [580, 580]])('retains the %s × %s program proportions after resizing and saving', (width, height) => {
    const node = interactiveNode();
    node.versions[0]!.interactive = { html: '', model: 'fixture', providerId: 'fixture', request: 'Fixture', viewportWidth: width, viewportHeight: height };
    node.versions[0]!.interactiveCanvasWidth = 480;
    const restored = JSON.parse(JSON.stringify(node)) as ScatterNode;
    expect(nodeWidth(restored)).toBe(480);
    expect(nodeBodyMaxH(restored)).toBe(Math.round(480 * height / width));
    restored.versions.push({ ...restored.versions[0]!, interactiveCanvasWidth: 840, createdAt: 2 });
    restored.currentVersionIndex = 1;
    expect(nodeWidth(restored)).toBe(840);
    restored.currentVersionIndex = 0;
    expect(nodeWidth(restored)).toBe(480);
  });
});
