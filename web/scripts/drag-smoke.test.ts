/* Minimal sanity check: dispatch drag-move, verify B ends at fx/fy. */
import { describe, test, expect } from 'vitest';
import {
  dispatchMessage, setEmit, tickOnce, stopAutoTimer,
} from '@/physics/physicsWorker';
import { DEFAULT_PHYSICS_CONFIG } from '@/physics/defaults';
import type { PhysicsConfig } from '@/store/types';

describe('drag pinning', () => {
  test('B should equal fx,fy after tick', () => {
    let lastTick: { id: string; x: number; y: number }[] = [];
    setEmit((msg) => { if (msg.type === 'tick') lastTick = msg.nodes; });
    dispatchMessage({
      type: 'init',
      nodes: [
        { id: 'A', x: 0, y: 0, frozen: false },
        { id: 'B', x: 0, y: 100, frozen: false },
        { id: 'C', x: 0, y: 200, frozen: false },
      ],
      links: [
        { source: 'A', target: 'B', kind: 'auto', gravitates: false, arrowId: 'a1' },
      ],
    });
    dispatchMessage({ type: 'set-physics-config', config: DEFAULT_PHYSICS_CONFIG as PhysicsConfig });
    stopAutoTimer();
    // Drag B far away
    dispatchMessage({ type: 'drag-move', id: 'B', x: 500, y: 800 });
    stopAutoTimer();
    tickOnce();
    const b = lastTick.find((n) => n.id === 'B');
    console.log('B after one tick:', b);
    console.log('expected: (500, 800)');
    expect(b).toBeDefined();
    // Hard pin should put B exactly at cursor
    expect(b!.x).toBeCloseTo(500, 1);
    expect(b!.y).toBeCloseTo(800, 1);
  });
});
