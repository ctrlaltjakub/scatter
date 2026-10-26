import type { PhysicsConfig } from '@/store/types';
import type { SourcePort } from './sourcePort';

type Position = { id: string; x: number; y: number };
type AnchorPos = { x: number; y: number };
type ArrowAnchors = Record<string /* arrowId */, AnchorPos[]>;
type OnTick = (positions: Position[], arrowAnchors: ArrowAnchors, removedArrowIds: string[]) => void;
export type SizeWake = 'normal' | 'gentle' | 'none';

/** User-input events that drive the simulation. Captured by the sandbox
 *  recorder so a session can be replayed by feeding the same events back
 *  in. */
export type InputEvent =
  | { type: 'drag-start'; id: string; x: number; y: number }
  | { type: 'drag-move'; id: string; x: number; y: number }
  | { type: 'drag-end'; id: string }
  | { type: 'drag-end-many'; ids: string[] }
  | { type: 'arrow-drag-start'; arrowId: string; x: number; y: number }
  | { type: 'arrow-drag-move'; arrowId: string; x: number; y: number }
  | { type: 'arrow-drag-end'; arrowId: string };

type OnInput = (e: InputEvent) => void;

export class PhysicsClient {
  private worker: Worker;
  private listeners = new Set<OnTick>();
  private inputListeners = new Set<OnInput>();

  private emitInput(e: InputEvent): void {
    for (const fn of this.inputListeners) fn(e);
  }

  constructor() {
    this.worker = new Worker(new URL('./physicsWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === 'tick') {
        for (const fn of this.listeners) fn(m.nodes, m.arrowAnchors, m.removedArrowIds ?? []);
      }
    };
    // A worker that fails to load/parse (bad chunk URL, blocked, unsupported)
    // is otherwise completely silent — nodes just never move. Log it so a dead
    // simulation is diagnosable in the field instead of a mystery.
    this.worker.onerror = (e: ErrorEvent) => {
      // eslint-disable-next-line no-console
      console.error('[physics] worker failed — simulation not running:', e.message || e);
    };
    this.worker.onmessageerror = (e) => {
      // eslint-disable-next-line no-console
      console.error('[physics] worker message could not be deserialized:', e);
    };
  }

  init(nodes: { id: string; x: number; y: number; frozen: boolean }[],
       links: { source: string; target: string; kind: 'auto' | 'dotted'; gravitates: boolean; arrowId: string; anchors?: AnchorPos[] }[],
       config?: PhysicsConfig) {
    this.worker.postMessage({ type: 'init', nodes, links, config });
  }
  addNode(node: { id: string; x: number; y: number; frozen: boolean }) {
    this.worker.postMessage({ type: 'add-node', node });
  }
  addLink(link: { source: string; target: string; kind: 'auto' | 'dotted'; gravitates: boolean; arrowId: string; anchors?: AnchorPos[] }) {
    this.worker.postMessage({ type: 'add-link', link });
  }
  removeLinks(ids: string[]) {
    this.worker.postMessage({ type: 'remove-links', ids });
  }
  removeNodes(ids: string[]) {
    this.worker.postMessage({ type: 'remove-nodes', ids });
  }
  setFrozen(id: string, frozen: boolean) {
    this.worker.postMessage({ type: 'set-frozen', id, frozen });
  }
  setSize(id: string, width: number, height: number, opts?: { wake?: SizeWake }) {
    this.worker.postMessage({ type: 'set-size', id, width, height, wake: opts?.wake });
  }
  setArrowSources(sources: { arrowId: string; sourcePort?: SourcePort }[]) {
    this.worker.postMessage({ type: 'set-arrow-sources', sources });
  }
  setConfig(config: PhysicsConfig) {
    this.worker.postMessage({ type: 'set-physics-config', config });
  }
  dragStart(id: string, x: number, y: number) {
    this.emitInput({ type: 'drag-start', id, x, y });
    this.worker.postMessage({ type: 'drag-start', id, x, y });
  }
  dragMove(id: string, x: number, y: number) {
    this.emitInput({ type: 'drag-move', id, x, y });
    this.worker.postMessage({ type: 'drag-move', id, x, y });
  }
  dragEnd(id: string) {
    this.emitInput({ type: 'drag-end', id });
    this.worker.postMessage({ type: 'drag-end', id });
  }
  dragEndMany(ids: string[]) {
    this.emitInput({ type: 'drag-end-many', ids });
    this.worker.postMessage({ type: 'drag-end-many', ids });
  }
  arrowDragStart(arrowId: string, x: number, y: number) {
    this.emitInput({ type: 'arrow-drag-start', arrowId, x, y });
    this.worker.postMessage({ type: 'arrow-drag-start', arrowId, x, y });
  }
  arrowDragMove(arrowId: string, x: number, y: number) {
    this.emitInput({ type: 'arrow-drag-move', arrowId, x, y });
    this.worker.postMessage({ type: 'arrow-drag-move', arrowId, x, y });
  }
  arrowDragEnd(arrowId: string) {
    this.emitInput({ type: 'arrow-drag-end', arrowId });
    this.worker.postMessage({ type: 'arrow-drag-end', arrowId });
  }
  pause() { this.worker.postMessage({ type: 'pause' }); }
  resume() { this.worker.postMessage({ type: 'resume' }); }
  onTick(fn: OnTick) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onInput(fn: OnInput) { this.inputListeners.add(fn); return () => this.inputListeners.delete(fn); }
  terminate() { this.worker.terminate(); }
}
