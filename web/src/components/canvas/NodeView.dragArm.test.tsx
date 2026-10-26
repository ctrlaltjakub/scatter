/**
 * Drag-away "armed to pin" indicator.
 *
 * While a child node is dragged past the auto-pin threshold, Canvas marks it
 * armed (useDragArmStore). Its pin button then pulses (opacity, via `.arming`)
 * — telling the user "let go and I'll stick". This is per-node: only the armed
 * node lights up.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { NodeView } from './NodeView';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useDragArmStore } from '@/store/useDragArmStore';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'globals.css'),
  'utf8',
);

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const cls = (this as HTMLElement).classList;
    let h = 0;
    const w = 480;
    if (cls?.contains('sc-ab-root')) h = 280;
    else if (cls?.contains('sc-ab-freetext')) h = 40;
    else if (cls?.contains('sc-ab-item')) h = 28;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  useDragArmStore.getState().setArmed(null);
});

const noop = () => {};

function makeNode(id: string): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{ header: 'Node', body: 'Body.', createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

function renderNode() {
  const node = makeNode('n0');
  const proj = createBlankProject('t', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
  useGraphStore.temporal.getState().pause();
  return render(
    <NodeView
      node={node}
      selected={false}
      onSelect={noop}
      onReferenceClick={noop}
      onDragStart={noop}
      onDragMove={noop}
      onDragEnd={noop}
    />,
  );
}

describe('NodeView — armed-to-pin indicator', () => {
  it('uses the enlarged 18px glyph inside the corner pin button', () => {
    const { container } = renderNode();
    expect(container.querySelector('.node-corner-btn.right svg')).toHaveAttribute('width', '18');
  });

  it('shows a pinned icon and applies distance-responsive variables while armed', () => {
    const { container } = renderNode();
    const pinBtn = container.querySelector<HTMLButtonElement>('.node-corner-btn.right')!;
    expect(pinBtn.classList.contains('arming')).toBe(false);
    expect(pinBtn.querySelector('.lucide-pin-off')).toBeTruthy();

    act(() => useDragArmStore.getState().setArmed('n0', 0.5));
    expect(pinBtn.classList.contains('arming')).toBe(true);
    expect(pinBtn.querySelector('.lucide-pin')).toBeTruthy();
    expect(pinBtn.querySelector('.lucide-pin-off')).toBeNull();
    expect(pinBtn.style.getPropertyValue('--pin-arm-scale')).toBe('1.150');
    expect(pinBtn.style.getPropertyValue('--pin-arm-x')).toBe('1.44px');
    expect(pinBtn.style.getPropertyValue('--pin-arm-y')).toBe('0.22px');
    expect(pinBtn.style.getPropertyValue('--pin-arm-duration')).toBe('330ms');
    expect(pinBtn.style.transform).toBe('');

    act(() => useDragArmStore.getState().setArmed(null));
    expect(pinBtn.classList.contains('arming')).toBe(false);
    expect(pinBtn.querySelector('.lucide-pin-off')).toBeTruthy();
    expect(pinBtn.style.getPropertyValue('--pin-arm-scale')).toBe('');
    expect(pinBtn.style.getPropertyValue('--pin-arm-x')).toBe('');
    expect(pinBtn.style.getPropertyValue('--pin-arm-y')).toBe('');
    expect(pinBtn.style.getPropertyValue('--pin-arm-duration')).toBe('');
  });

  it('does not light up when a DIFFERENT node is the armed one', () => {
    const { container } = renderNode();
    act(() => useDragArmStore.getState().setArmed('someone-else'));
    expect(container.querySelector('.node-corner-btn.right')!.classList.contains('arming')).toBe(false);
  });

  it('uses icon-only transform shaking and retains a static scale for reduced motion', () => {
    expect(css).not.toContain('sc-pin-arm-pulse');
    expect(css).toContain('@keyframes sc-pin-arm-shake');
    expect(css).toMatch(/\.node-corner-btn\.right\.arming\s*>\s*svg/);
    expect(css).toMatch(/\.node-corner-btn\.right\.arming\s*\{[^}]*color:\s*var\(--text\)/);
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*animation:\s*none/);
  });
});
