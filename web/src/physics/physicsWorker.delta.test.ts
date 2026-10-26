import { beforeEach, describe, expect, it } from 'vitest';
import { imageRegionFrame } from '@/lib/imageRegionFrame';
import {
  dispatchMessage,
  setEmit,
  setForceEmitEveryTick,
  stopAutoTimer,
  tickOnce,
} from './physicsWorker';

type TickMessage = {
  type: 'tick';
  nodes: { id: string; x: number; y: number }[];
  arrowAnchors: Record<string, { x: number; y: number }[]>;
  removedArrowIds?: string[];
};

describe('physics worker delta output', () => {
  const messages: TickMessage[] = [];

  beforeEach(() => {
    messages.length = 0;
    setForceEmitEveryTick(false);
    setEmit((message) => messages.push(message));
    dispatchMessage({
      type: 'init',
      nodes: [
        { id: 'a', x: 0, y: 0, frozen: true },
        { id: 'b', x: 900, y: 0, frozen: true },
      ],
      links: [{
        source: 'a', target: 'b', kind: 'auto', gravitates: true, arrowId: 'ab',
        anchors: [{ x: 624, y: 60 }, { x: 760, y: 60 }, { x: 900, y: 60 }],
      }],
    });
    stopAutoTimer();
  });

  it('does not resend the main-thread-seeded project while settled', () => {
    tickOnce();
    expect(messages).toHaveLength(0);
  });

  it('emits only the node changed by a drag', () => {
    dispatchMessage({ type: 'drag-start', id: 'a', x: 0, y: 0 });
    dispatchMessage({ type: 'drag-move', id: 'a', x: 120, y: 40 });
    stopAutoTimer();
    tickOnce();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.nodes.map((node) => node.id)).toEqual(['a']);
  });

  it('reports removed chains without resending unchanged anchors', () => {
    dispatchMessage({ type: 'remove-links', ids: ['ab'] });
    stopAutoTimer();
    tickOnce();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.arrowAnchors).toEqual({});
    expect(messages[0]!.removedArrowIds).toEqual(['ab']);
  });
  it('publishes image source geometry without moving nodes or waking layout forces', () => {
    dispatchMessage({ type: 'set-size', id: 'a', width: 624, height: 120 });
    dispatchMessage({ type: 'set-size', id: 'b', width: 624, height: 120 });
    const frame = imageRegionFrame([{ x: .1, y: .1, width: .2, height: .2 }], { x: 0, y: 0, width: 400, height: 300 })!;
    dispatchMessage({ type: 'set-arrow-sources', sources: [{ arrowId: 'ab', sourcePort: frame.port }] });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.nodes).toEqual([]);
    expect(messages[0]!.arrowAnchors.ab![0]!.x).toBeCloseTo(120);
    expect(messages[0]!.arrowAnchors.ab![0]!.y).toBeCloseTo(60);
  });
});
