'use client';
import { useLayoutEffect, type RefObject } from 'react';
import { cancelParentPick, chooseParent, useParentPickStore, watchParentPick } from '@/store/useParentPickStore';
import { useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';

const UI = 'button,a[href],input,textarea,select,[role="button"],[contenteditable="true"],.node-resize,.node-followup-bar,.side-panel,.citations-panel,.canvas-topright';
const element = (e: Event) => e.target instanceof Element ? e.target : null;
const nodeOf = (el: Element | null) => el?.closest<HTMLElement>('.node[data-node-id]')?.dataset.nodeId;
function isControl(el: Element | null) {
  const control = el?.closest(UI);
  // Terms and expandable bullets are part of the target surface, not an
  // invitation to spawn a new node while choosing a parent.
  return !!control && !control.matches('.ref-chip,.sc-ab-item,.cite-marker,.source-selection-mark');
}
const claim = (e: Event) => { if (e.cancelable) e.preventDefault(); e.stopImmediatePropagation(); };

/** Own only the target pick. Blank-canvas pans, wheel, pinch and keyboard
 * camera controls continue through the existing camera implementation. */
export function useParentPickInput(hostRef: RefObject<HTMLElement | null>) {
  const pick = useParentPickStore(s => s.pick);
  const token = pick?.startedAt;
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || token == null) return;
    const abort = new AbortController(), capture = { capture: true, signal: abort.signal };
    const unwatch = watchParentPick();
    let press: { nodeId: string; id: number; x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    let tappedId: string | null = null;
    const otherUI = (e: Event) => {
      const el = element(e);
      if (el?.closest('[data-parent-picker-control]')) return;
      if (!el || !host.contains(el) || isControl(el)) cancelParentPick();
    };
    window.addEventListener('pointerdown', otherUI, capture);
    window.addEventListener('click', otherUI, capture); // keyboard-activated controls, too
    window.addEventListener('pointermove', e => {
      const current = useParentPickStore.getState().pick;
      if (current && e.isPrimary !== false) { current.pointer.x = e.clientX; current.pointer.y = e.clientY; }
    }, capture);
    host.addEventListener('pointerdown', e => {
      const el = element(e), nodeId = nodeOf(el);
      tappedId = null;
      if (!useParentPickStore.getState().pick || e.defaultPrevented || !nodeId || e.button !== 0 || isControl(el)) return;
      const view = useLiveViewportStore.getState();
      press = { nodeId, id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      el!.closest<HTMLElement>('.node')?.setPointerCapture?.(e.pointerId);
      // The host's pinch listener observes contacts before us. The card must
      // never see pointerdown: even its header must not grab a physics body.
      claim(e);
    }, capture);
    host.addEventListener('pointermove', e => {
      if (!press || e.pointerId !== press.id || e.defaultPrevented) return;
      const dx = e.clientX - press.x, dy = e.clientY - press.y;
      if (Math.hypot(dx, dy) >= 5) press.moved = true;
      if (press.moved) useLiveViewportStore.getState().setPan(press.vx + dx, press.vy + dy);
      claim(e);
    }, capture);
    host.addEventListener('pointerup', e => {
      if (!press || e.pointerId !== press.id) return;
      const releasedOn = document.elementFromPoint?.(e.clientX, e.clientY) ?? element(e);
      tappedId = !e.defaultPrevented && !press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5
        && !isControl(releasedOn) && nodeOf(releasedOn) === press.nodeId ? press.nodeId : null;
      if (press.moved) {
        const { x, y, zoom } = useLiveViewportStore.getState();
        useGraphStore.getState().setViewport({ x, y, zoom });
      }
      // Commit on click, not on down/up: a drag or a pinch must not pick.
      press = null;
      e.stopPropagation();
    }, capture);
    host.addEventListener('pointercancel', () => { press = null; tappedId = null; }, capture);
    host.addEventListener('click', e => {
      const el = element(e), id = nodeOf(el);
      if (!useParentPickStore.getState().pick || !id || isControl(el)) return;
      claim(e);
      if (e.detail === 0 || tappedId === id) chooseParent(id);
      tappedId = null;
    }, capture);
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      claim(e); cancelParentPick();
    }, capture);
    window.addEventListener('blur', cancelParentPick, { signal: abort.signal });
    return () => { abort.abort(); unwatch(); if (useParentPickStore.getState().pick?.startedAt === token) cancelParentPick(); };
  }, [hostRef, token]);
  return pick;
}
