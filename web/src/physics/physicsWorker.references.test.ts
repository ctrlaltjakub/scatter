import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS_CONFIG } from './defaults';
import { dispatchMessage, endLoadFrictionForTest, setEmit, setForceEmitEveryTick, stopAutoTimer, tickOnce } from './physicsWorker';

let last: { nodes: { id: string; x: number; y: number }[]; arrowAnchors: Record<string, { x: number; y: number }[]> };
const reference = (kind: 'auto' | 'dotted', gravitates: boolean) => ({ source: 'a', target: 'b', arrowId: 'ab', kind, gravitates });
function load(gravitates: boolean) {
  setEmit((message) => { last = message; });
  setForceEmitEveryTick(true);
  dispatchMessage({ type: 'init', nodes: [{ id: 'a', x: 0, y: 0, frozen: true }, { id: 'b', x: 1200, y: 0, frozen: false }],
    links: [reference('dotted', gravitates)],
    config: { ...DEFAULT_PHYSICS_CONFIG, linkedRepelStrength: 2000, unlinkedRepelStrength: 0 } });
  for (const id of ['a', 'b']) dispatchMessage({ type: 'set-size', id, width: 100, height: 80 });
  stopAutoTimer(); endLoadFrictionForTest();
}
function advance() {
  dispatchMessage({ type: 'resume' }); stopAutoTimer();
  for (let i = 0; i < 50; i++) tickOnce();
}
afterEach(() => { stopAutoTimer(); setForceEmitEveryTick(false); setEmit(() => {}); });

describe('dotted reference physics', () => {
  it.each([false, true])('never attracts or uses structural repulsion, even with legacy gravitates=%s', (gravitates) => {
    load(gravitates); advance();
    expect(last.nodes.find((node) => node.id === 'b')).toEqual({ id: 'b', x: 1200, y: 0 });
    expect(last.arrowAnchors.ab!.length).toBeGreaterThanOrEqual(2);
    dispatchMessage({ type: 'drag-start', id: 'b', x: 1400, y: 100 }); stopAutoTimer(); tickOnce();
    expect(last.arrowAnchors.ab!.at(-1)!.x).toBeGreaterThanOrEqual(1399);
  });
  it('begins attracting once the same reference becomes a structural arrow', () => {
    load(false); advance();
    expect(last.nodes.find((node) => node.id === 'b')!.x).toBe(1200);
    dispatchMessage({ type: 'remove-links', ids: ['ab'] });
    dispatchMessage({ type: 'add-link', link: reference('auto', false) });
    advance();
    expect(last.nodes.find((node) => node.id === 'b')!.x).toBeLessThan(1190);
  });
});
